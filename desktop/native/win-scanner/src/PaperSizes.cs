using System.Collections.Generic;
using System.Linq;

namespace Paperwing.Scan;

/// <summary>Named paper sizes: the scanner's own list (WIA page sizes, TWAIN supported sizes) or common ones</summary>
internal static class PaperSizes
{
    // Sizes in thousandths of an inch (as WiaDef.h gives them)
    private static readonly Dictionary<string, (int W, int H)> Known = new()
    {
        ["Letter"] = (8500, 11000),
        ["Legal"] = (8500, 14000),
        ["Tabloid"] = (11000, 17000),
        ["Executive"] = (7250, 10500),
        ["Statement"] = (5500, 8500),
        ["Business card"] = (3543, 2165),
        ["Photo 4 × 6 in"] = (4000, 6000),
        ["Photo 5 × 7 in"] = (5000, 7000),
        ["A0"] = (33110, 46811), ["A1"] = (23385, 33110), ["A2"] = (16535, 23385), ["A3"] = (11692, 16535),
        ["A4"] = (8267, 11692), ["A5"] = (5826, 8267), ["A6"] = (4133, 5826), ["A7"] = (2913, 4133),
        ["A8"] = (2047, 2913), ["A9"] = (1456, 2047), ["A10"] = (1023, 1456),
        ["B0 (ISO)"] = (39370, 55669), ["B1 (ISO)"] = (27834, 39370), ["B2 (ISO)"] = (19685, 27834),
        ["B3 (ISO)"] = (13897, 19685), ["B4 (ISO)"] = (9842, 13897), ["B5 (ISO)"] = (6929, 9842),
        ["B6 (ISO)"] = (4921, 6929), ["B7 (ISO)"] = (3464, 4921), ["B8 (ISO)"] = (2440, 3464),
        ["B9 (ISO)"] = (1732, 2440), ["B10 (ISO)"] = (1220, 1732),
        ["C0"] = (36102, 51062), ["C1"] = (25511, 36102), ["C2"] = (18031, 25511), ["C3"] = (12755, 18031),
        ["C4"] = (9015, 12755), ["C5"] = (6377, 9015), ["C6"] = (4488, 6377), ["C7"] = (3188, 4488),
        ["C8"] = (2244, 3188), ["C9"] = (1574, 2244), ["C10"] = (1102, 1574),
        ["B0 (JIS)"] = (40551, 57322), ["B1 (JIS)"] = (28661, 40551), ["B2 (JIS)"] = (20275, 28661),
        ["B3 (JIS)"] = (14330, 20275), ["B4 (JIS)"] = (10118, 14330), ["B5 (JIS)"] = (7165, 10118),
        ["B6 (JIS)"] = (5039, 7165), ["B7 (JIS)"] = (3582, 5039), ["B8 (JIS)"] = (2519, 3582),
        ["B9 (JIS)"] = (1771, 2519), ["B10 (JIS)"] = (1259, 1771),
        ["4A0"] = (66220, 93622), ["2A0"] = (46811, 66220),
    };

    /// <summary>What's offered when the scanner has no list of its own</summary>
    private static readonly string[] Common =
    {
        "Letter", "Legal", "Tabloid", "Executive", "Statement", "A3", "A4", "A5", "A6",
        "B5 (ISO)", "B5 (JIS)", "Business card", "Photo 4 × 6 in", "Photo 5 × 7 in",
    };

    /// <summary>WIA_IPS_PAGE_SIZE values (WIA_PAGE_*)</summary>
    private static readonly Dictionary<int, string> WiaNames = BuildWia();

    /// <summary>ICAP_SUPPORTEDSIZES values (TWSS_*)</summary>
    private static readonly Dictionary<int, string> TwainNames = new()
    {
        [1] = "A4", [2] = "B5 (JIS)", [3] = "Letter", [4] = "Legal", [5] = "A5", [6] = "B4 (ISO)",
        [7] = "B6 (ISO)", [9] = "Tabloid", [10] = "Executive", [11] = "A3", [12] = "B3 (ISO)", [13] = "A6",
        [14] = "C4", [15] = "C5", [16] = "C6", [17] = "4A0", [18] = "2A0", [19] = "A0", [20] = "A1",
        [21] = "A2", [22] = "A7", [23] = "A8", [24] = "A9", [25] = "A10", [26] = "B0 (ISO)",
        [27] = "B1 (ISO)", [28] = "B2 (ISO)", [29] = "B5 (ISO)", [30] = "B7 (ISO)", [31] = "B8 (ISO)",
        [32] = "B9 (ISO)", [33] = "B10 (ISO)", [34] = "B0 (JIS)", [35] = "B1 (JIS)", [36] = "B2 (JIS)",
        [37] = "B3 (JIS)", [38] = "B4 (JIS)", [39] = "B6 (JIS)", [40] = "B7 (JIS)", [41] = "B8 (JIS)",
        [42] = "B9 (JIS)", [43] = "B10 (JIS)", [44] = "C0", [45] = "C1", [46] = "C2", [47] = "C3",
        [48] = "C7", [49] = "C8", [50] = "C9", [51] = "C10", [52] = "Statement", [53] = "Business card",
    };

    public const int WiaPageCustom = 2;
    public const int WiaPageAuto = 100;

    private static Dictionary<int, string> BuildWia()
    {
        var d = new Dictionary<int, string>
        {
            [0] = "A4", [1] = "Letter", [3] = "Legal", [4] = "Tabloid", [5] = "Statement", [6] = "Business card",
            [7] = "A0", [8] = "A1", [9] = "A2", [10] = "A3", [11] = "A5", [12] = "A6", [13] = "A7", [14] = "A8",
            [15] = "A9", [16] = "A10",
        };
        for (var i = 0; i <= 10; i++)
        {
            d[17 + i] = $"B{i} (ISO)";
            d[28 + i] = $"C{i}";
            d[39 + i] = $"B{i} (JIS)";
        }
        return d;
    }

    /// <summary>Paper sizes for WIA_IPS_PAGE_SIZE values, keeping those that fit</summary>
    public static List<PaperSize> FromWia(IEnumerable<int> values, double maxW, double maxH) =>
        Fitting(values.Select(v => WiaNames.TryGetValue(v, out var n) ? n : null), maxW, maxH);

    /// <summary>Paper sizes for ICAP_SUPPORTEDSIZES values, keeping those that fit</summary>
    public static List<PaperSize> FromTwain(IEnumerable<int> values, double maxW, double maxH) =>
        Fitting(values.Select(v => TwainNames.TryGetValue(v, out var n) ? n : null), maxW, maxH);

    /// <summary>The common sizes that fit</summary>
    public static List<PaperSize> CommonFitting(double maxW, double maxH) => Fitting(Common, maxW, maxH);

    private static List<PaperSize> Fitting(IEnumerable<string?> names, double maxW, double maxH)
    {
        // A little slack: scanners sold as "A4" often measure 8.5 × 11.69
        const double Slack = 0.06;
        var result = new List<PaperSize>();
        foreach (var name in names.Distinct())
        {
            if (name == null || !Known.TryGetValue(name, out var size)) continue;
            var w = size.W / 1000.0;
            var h = size.H / 1000.0;
            if (maxW > 0 && maxH > 0 && (w > maxW + Slack || h > maxH + Slack)) continue;
            result.Add(new PaperSize(name, w, h));
        }
        return result;
    }
}
