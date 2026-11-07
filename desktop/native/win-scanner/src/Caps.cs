using System.Collections.Generic;
using System.Linq;

namespace Paperwing.Scan;

/// <summary>A setting's range in the scanner's own units</summary>
internal sealed class RangeCap
{
    public RangeCap(double min, double max, double step, double @default)
    {
        Min = min;
        Max = max;
        Step = step;
        Default = @default;
    }

    public double Min { get; }
    public double Max { get; }
    public double Step { get; }
    public double Default { get; }

    public Dictionary<string, object?> ToJson() => new()
    {
        ["min"] = Min,
        ["max"] = Max,
        ["step"] = Step,
        ["default"] = Default,
    };
}

internal sealed class PaperSize
{
    public PaperSize(string name, double width, double height)
    {
        Name = name;
        Width = width;
        Height = height;
    }

    public string Name { get; }
    /// <summary>Inches</summary>
    public double Width { get; }
    public double Height { get; }

    public Dictionary<string, object?> ToJson() => new()
    {
        ["name"] = Name,
        ["width"] = Geometry.Round(Width),
        ["height"] = Geometry.Round(Height),
    };
}

/// <summary>What one source (flatbed or feeder) can do: the "sources" of caps</summary>
internal sealed class SourceCaps
{
    public string Id { get; set; } = "flatbed";
    public bool Duplex { get; set; }
    /// <summary>The scanner's list of resolutions, or null when it gives a range</summary>
    public List<int>? Resolutions { get; set; }
    public RangeCap? ResolutionRange { get; set; }
    public List<string> Colors { get; set; } = new();
    public double MaxWidth { get; set; }
    public double MaxHeight { get; set; }
    public double MinWidth { get; set; }
    public double MinHeight { get; set; }
    public bool CanPreview { get; set; }
    public List<PaperSize> PaperSizes { get; set; } = new();
    public bool AutoSize { get; set; }
    public bool AutoDeskew { get; set; }
    public bool AutoCrop { get; set; }
    public bool BlankPageSkip { get; set; }
    public bool DoubleFeed { get; set; }
    public bool Invert { get; set; }
    public RangeCap? Brightness { get; set; }
    public RangeCap? Contrast { get; set; }
    public RangeCap? Threshold { get; set; }
    public bool? FeederLoaded { get; set; }

    public Dictionary<string, object?> ToJson()
    {
        object? resolutions = Resolutions != null
            ? Resolutions.Distinct().OrderBy(d => d).ToList()
            : ResolutionRange != null
                ? new Dictionary<string, object?>
                {
                    ["min"] = ResolutionRange.Min,
                    ["max"] = ResolutionRange.Max,
                    ["step"] = ResolutionRange.Step,
                }
                : new List<int>();
        return new Dictionary<string, object?>
        {
            ["id"] = Id,
            ["duplex"] = Duplex,
            ["resolutions"] = resolutions,
            ["colors"] = Colors,
            ["maxWidth"] = Geometry.Round(MaxWidth),
            ["maxHeight"] = Geometry.Round(MaxHeight),
            ["minWidth"] = Geometry.Round(MinWidth),
            ["minHeight"] = Geometry.Round(MinHeight),
            ["canPreview"] = CanPreview,
            ["paperSizes"] = PaperSizes.Select(p => p.ToJson()).ToList(),
            ["autoSize"] = AutoSize,
            ["autoDeskew"] = AutoDeskew,
            ["autoCrop"] = AutoCrop,
            ["blankPageSkip"] = BlankPageSkip,
            ["doubleFeed"] = DoubleFeed,
            ["invert"] = Invert,
            ["brightness"] = Brightness?.ToJson(),
            ["contrast"] = Contrast?.ToJson(),
            ["threshold"] = Threshold?.ToJson(),
            ["feederLoaded"] = FeederLoaded,
        };
    }
}

/// <summary>One scanner as listed</summary>
internal sealed class ScannerInfo
{
    public ScannerInfo(string id, string name, string driver, string api, string make, string model, string connection)
    {
        Id = id;
        Name = name;
        Driver = driver;
        Api = api;
        Make = make;
        Model = model;
        Connection = connection;
    }

    public string Id { get; }
    public string Name { get; }
    /// <summary>"wia" or "twain"</summary>
    public string Driver { get; }
    /// <summary>"wia2", "wia1", "twain64" or "twain32": for scan.cjs's driver order</summary>
    public string Api { get; }
    public string Make { get; }
    public string Model { get; }
    public string Connection { get; }
    /// <summary>Disambiguates identical scanners (USB serial, port)</summary>
    public string? Instance { get; set; }
    public string DeviceKey { get; set; } = "";

    public Dictionary<string, object?> ToJson() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["driver"] = Driver,
        ["api"] = Api,
        ["deviceKey"] = DeviceKey,
        ["make"] = Make,
        ["model"] = Model,
        ["connection"] = Connection,
    };
}
