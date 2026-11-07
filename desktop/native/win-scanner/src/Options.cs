using System;
using System.Collections.Generic;
using System.Text;

namespace Paperwing.Scan;

/// <summary>A scan area in inches from the top-left corner of the scanner's area</summary>
internal readonly struct RectIn
{
    public RectIn(double x, double y, double width, double height)
    {
        X = x;
        Y = y;
        Width = width;
        Height = height;
    }

    public double X { get; }
    public double Y { get; }
    public double Width { get; }
    public double Height { get; }

    public override string ToString() => $"{X},{Y} {Width}x{Height}";
}

/// <summary>
/// The -Options of preview and scan (base64 of a JSON object). Anything
/// absent is left at the scanner's default.
/// </summary>
internal sealed class ScanOptions
{
    public string? Source { get; private set; }
    public bool Duplex { get; private set; }
    public string? Color { get; private set; }
    public int? Dpi { get; private set; }
    /// <summary>An explicit area (from the preview), in inches</summary>
    public RectIn? Area { get; private set; }
    /// <summary>A paper size (width, height in inches), placed as the scanner aligns paper</summary>
    public RectIn? Paper { get; private set; }
    /// <summary>"area": "auto": the scanner finds the page's size</summary>
    public bool AutoArea { get; private set; }
    public double? Brightness { get; private set; }
    public double? Contrast { get; private set; }
    public double? Threshold { get; private set; }
    public bool? AutoDeskew { get; private set; }
    public bool? BlankPageSkip { get; private set; }
    public bool? DoubleFeedStop { get; private set; }
    public bool Invert { get; private set; }
    public bool NativeUi { get; private set; }
    public string? Transfer { get; private set; }
    /// <summary>WIA drivers that read the X extent as the right edge (NAPS2's "offset width")</summary>
    public bool OffsetWidth { get; private set; }

    public bool Feeder => Source == "feeder";

    public static ScanOptions Parse(string? base64)
    {
        if (string.IsNullOrWhiteSpace(base64)) return new ScanOptions();
        string json;
        try
        {
            json = Encoding.UTF8.GetString(Convert.FromBase64String(base64!.Trim()));
        }
        catch (FormatException)
        {
            throw Invalid("-Options isn't base64");
        }
        return FromJson(json);
    }

    public static ScanOptions FromJson(string json)
    {
        object? parsed;
        try
        {
            parsed = Json.Parse(json);
        }
        catch (FormatException e)
        {
            throw Invalid("-Options isn't JSON: " + e.Message);
        }
        if (parsed is not Dictionary<string, object?> o) throw Invalid("-Options must be a JSON object");

        var opts = new ScanOptions
        {
            Source = OneOf(o, "source", "flatbed", "feeder"),
            Duplex = Bool(o, "duplex") ?? false,
            Color = OneOf(o, "color", "color", "gray", "bw"),
            Brightness = Number(o, "brightness"),
            Contrast = Number(o, "contrast"),
            Threshold = Number(o, "threshold"),
            AutoDeskew = Bool(o, "autoDeskew"),
            BlankPageSkip = Bool(o, "blankPageSkip"),
            DoubleFeedStop = Bool(o, "doubleFeedStop"),
            Invert = Bool(o, "invert") ?? false,
            NativeUi = Bool(o, "nativeUi") ?? false,
            Transfer = OneOf(o, "transfer", "native", "memory"),
            OffsetWidth = Bool(o, "offsetWidth") ?? false,
        };

        var dpi = Number(o, "dpi");
        if (dpi != null)
        {
            if (dpi < 10 || dpi > 19200 || dpi != Math.Floor(dpi.Value)) throw Invalid("dpi must be a whole number from 10 to 19200");
            opts.Dpi = (int)dpi.Value;
        }

        if (o.TryGetValue("area", out var area) && area != null)
        {
            if (area is string s && s == "auto")
                opts.AutoArea = true;
            else if (area is Dictionary<string, object?> a)
                opts.Area = new RectIn(Inches(a, "x", true), Inches(a, "y", true), Inches(a, "width", false), Inches(a, "height", false));
            else
                throw Invalid("area must be {x,y,width,height} or \"auto\"");
        }
        if (o.TryGetValue("paper", out var paper) && paper != null)
        {
            if (paper is string s && s == "auto")
                opts.AutoArea = true;
            else if (paper is Dictionary<string, object?> p)
                opts.Paper = new RectIn(0, 0, Inches(p, "width", false), Inches(p, "height", false));
            else
                throw Invalid("paper must be {width,height} or \"auto\"");
        }
        return opts;
    }

    /// <summary>The preview: the whole flatbed at a low resolution, one page</summary>
    public ScanOptions ForPreview(int dpi)
    {
        var copy = (ScanOptions)MemberwiseClone();
        copy.Source = "flatbed";
        copy.Duplex = false;
        copy.Dpi = dpi;
        copy.Area = null;
        copy.Paper = null;
        copy.AutoArea = false;
        copy.AutoDeskew = null;
        copy.BlankPageSkip = null;
        copy.DoubleFeedStop = null;
        copy.NativeUi = false;
        return copy;
    }

    /// <summary>The source chosen by default: the flatbed if there is one</summary>
    public ScanOptions WithSource(string source)
    {
        var copy = (ScanOptions)MemberwiseClone();
        copy.Source = source;
        if (source != "feeder") copy.Duplex = false;
        return copy;
    }

    private static ScanException Invalid(string message) => new(ErrorCodes.Failed, "Invalid scan options: " + message);

    private static string? OneOf(Dictionary<string, object?> o, string key, params string[] allowed)
    {
        if (!o.TryGetValue(key, out var v) || v == null) return null;
        if (v is string s && Array.IndexOf(allowed, s) >= 0) return s;
        throw Invalid($"{key} must be one of {string.Join(", ", allowed)}");
    }

    private static bool? Bool(Dictionary<string, object?> o, string key)
    {
        if (!o.TryGetValue(key, out var v) || v == null) return null;
        if (v is bool b) return b;
        throw Invalid($"{key} must be true or false");
    }

    private static double? Number(Dictionary<string, object?> o, string key)
    {
        if (!o.TryGetValue(key, out var v) || v == null) return null;
        if (v is double d && !double.IsNaN(d) && !double.IsInfinity(d)) return d;
        throw Invalid($"{key} must be a number");
    }

    private static double Inches(Dictionary<string, object?> o, string key, bool allowZero)
    {
        var v = Number(o, key) ?? throw Invalid($"{key} is missing");
        if (v < 0 || (!allowZero && v <= 0) || v > 200) throw Invalid($"{key} is out of range");
        return v;
    }
}
