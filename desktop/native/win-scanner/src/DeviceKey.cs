using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Paperwing.Scan;

/// <summary>
/// deviceKey: the same string for one physical scanner whichever way it's
/// reached (WIA, TWAIN 64/32-bit), so scan.cjs can show it once.
///
/// The heuristic: "make:model", both normalised:
/// - make: lower case, letters and digits only, company suffixes dropped
///   ("Inc", "Corporation", "Ltd", "Industries"...), known aliases folded
///   ("Seiko Epson" = "epson", "Hewlett-Packard" = "hp", "PFU"/"Fujitsu" =
///   "fujitsu", "Kodak Alaris" = "kodak", "Brother Industries" = "brother").
/// - model: the model (or the name), with driver words dropped ("WIA",
///   "TWAIN", "TW", "driver", "series", "scanner", "x64", "(USB)"...), the
///   make's own words dropped (and Canon's "CanoScan", Fujitsu's
///   "PaperStream"), then letters and digits only. So "TW-Brother
///   MFC-L2710DW" (TWAIN) and "Brother MFC-L2710DW series" (WIA) are both
///   "brother:mfcl2710dw".
/// - Two identical scanners listed by the same driver get "#" and their
///   USB serial number (or port) added to the second and later ones, so they
///   stay apart. TWAIN can't tell identical units apart without opening the
///   driver (slow, and some drivers show messages), so it matches the first.
///
/// eSCL (desktop/escl.cjs) can make the same key from its mDNS "mfg" and
/// "ty" fields with the same rules.
/// </summary>
internal static class DeviceKey
{
    private static readonly HashSet<string> CompanyWords = new(StringComparer.Ordinal)
    {
        "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "gmbh",
        "ag", "sa", "plc", "kk", "bv", "srl", "industries", "electronics", "electric", "international",
        "technologies", "technology", "imaging", "solutions", "document", "systems", "america", "usa",
        "europe", "japan", "the",
    };

    private static readonly Dictionary<string, string> MakeAliases = new(StringComparer.Ordinal)
    {
        ["seikoepson"] = "epson",
        ["hewlettpackard"] = "hp",
        ["hpinc"] = "hp",
        ["pfu"] = "fujitsu",
        ["ricohpfu"] = "fujitsu",
        ["kodakalaris"] = "kodak",
        ["eastmankodak"] = "kodak",
        ["canoninc"] = "canon",
        ["kyoceramita"] = "kyocera",
        ["konicaminoltabusiness"] = "konicaminolta",
        ["fujixerox"] = "fujifilm",
        ["fujifilmbusinessinnovation"] = "fujifilm",
        ["visioneer"] = "visioneer",
        ["plustek"] = "plustek",
    };

    /// <summary>Words that are the make itself, in model names</summary>
    private static readonly Dictionary<string, string[]> MakeWords = new(StringComparer.Ordinal)
    {
        ["epson"] = new[] { "epson", "seiko" },
        ["hp"] = new[] { "hp", "hewlett", "packard" },
        ["canon"] = new[] { "canon", "canoscan" },
        ["fujitsu"] = new[] { "fujitsu", "pfu", "paperstream", "ip", "scansnap" },
        ["kodak"] = new[] { "kodak", "alaris" },
        ["brother"] = new[] { "brother" },
        ["konicaminolta"] = new[] { "konica", "minolta" },
    };

    private static readonly HashSet<string> DriverWords = new(StringComparer.Ordinal)
    {
        "wia", "twain", "twain2", "tw", "twain32", "twain64", "driver", "drv", "x64", "x86", "64bit",
        "32bit", "scanner", "scan", "series", "usb", "network", "net", "lan", "wifi", "wsd", "ds",
        "datasource", "source", "mfp",
    };

    public static string Make(string? make)
    {
        var tokens = Tokens(make).Where(t => !CompanyWords.Contains(t)).ToList();
        var joined = string.Concat(tokens);
        if (MakeAliases.TryGetValue(joined, out var alias)) return alias;
        // "Seiko Epson Corp." / "EPSON": an alias may be any run of the tokens
        foreach (var pair in MakeAliases)
            if (joined.Contains(pair.Key)) return pair.Value;
        foreach (var known in MakeWords)
            if (tokens.Any(t => known.Value.Contains(t))) return known.Key;
        return joined;
    }

    public static string Model(string? model, string makeKey)
    {
        // Parenthesised driver notes: "(TWAIN)", "(64-bit)", "(WIA)"
        var text = Regex.Replace(model ?? "", @"\(([^)]*)\)", m =>
            Tokens(m.Groups[1].Value).All(t => DriverWords.Contains(t) || t == "bit" || t == "32" || t == "64")
                ? " "
                : " " + m.Groups[1].Value + " ");
        // "64-bit" before splitting on punctuation
        text = Regex.Replace(text, @"\b(32|64)[\s-]?bit\b", " ", RegexOptions.IgnoreCase);
        var own = new HashSet<string>(StringComparer.Ordinal) { makeKey };
        if (MakeWords.TryGetValue(makeKey, out var words)) own.UnionWith(words);
        var tokens = Tokens(text).Where(t => !DriverWords.Contains(t) && !own.Contains(t));
        return string.Concat(tokens);
    }

    /// <summary>The key for one listing; name stands in for a missing model</summary>
    public static string For(string? make, string? model, string? name)
    {
        var makeKey = Make(make);
        if (makeKey.Length == 0) makeKey = Make(FirstWord(name));
        var modelKey = Model(string.IsNullOrWhiteSpace(model) ? name : model, makeKey);
        if (modelKey.Length == 0) modelKey = Model(name, makeKey);
        if (modelKey.Length == 0) modelKey = string.Concat(Tokens(name));
        return makeKey + ":" + modelKey;
    }

    /// <summary>Gives each scanner its key, keeping identical scanners apart</summary>
    public static void Assign(IList<ScannerInfo> scanners)
    {
        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var s in scanners)
        {
            var key = For(s.Make, s.Model, s.Name);
            var group = s.Driver + "|" + key;
            seen.TryGetValue(group, out var count);
            seen[group] = count + 1;
            if (count > 0) key += "#" + (string.IsNullOrEmpty(s.Instance) ? (count + 1).ToString() : s.Instance!.ToLowerInvariant());
            s.DeviceKey = key;
        }
    }

    /// <summary>
    /// The USB serial number in a PnP ID ("USB\VID_04B8&amp;PID_013A\SERIAL"),
    /// or null when Windows made the instance ID up (it then contains "&amp;").
    /// </summary>
    public static string? SerialFromPnpId(string? pnpId)
    {
        if (string.IsNullOrEmpty(pnpId)) return null;
        var parts = pnpId!.Split('\\');
        if (parts.Length < 3 || !parts[0].Equals("USB", StringComparison.OrdinalIgnoreCase)) return null;
        var instance = parts[2];
        return instance.Length > 0 && instance.IndexOf('&') < 0 ? instance : null;
    }

    private static string FirstWord(string? s) => Tokens(s).FirstOrDefault() ?? "";

    private static IEnumerable<string> Tokens(string? s)
    {
        if (string.IsNullOrEmpty(s)) yield break;
        var sb = new StringBuilder();
        foreach (var c in s!.ToLowerInvariant())
        {
            if (char.IsLetterOrDigit(c))
                sb.Append(c);
            else if (sb.Length > 0)
            {
                yield return sb.ToString();
                sb.Clear();
            }
        }
        if (sb.Length > 0) yield return sb.ToString();
    }
}
