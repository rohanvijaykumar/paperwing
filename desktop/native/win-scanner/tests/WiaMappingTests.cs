using System.Collections.Generic;
using System.Linq;
using Paperwing.Scan.Wia;
using Xunit;
using static Paperwing.Scan.Wia.WiaIds;

namespace Paperwing.Scan.Tests;

/// <summary>A WIA property store in memory, with a driver's validation rules</summary>
internal sealed class FakeProps : IWiaProps
{
    public readonly Dictionary<int, object> Values = new();
    public readonly Dictionary<int, WiaAttr> Attrs = new();
    /// <summary>Every successful set, in order</summary>
    public readonly List<(int Id, int Value)> Sets = new();
    public readonly HashSet<int> ReadOnly = new();

    public FakeProps Int(int id, int value, WiaAttr? attr = null)
    {
        Values[id] = value;
        if (attr != null) Attrs[id] = attr;
        return this;
    }

    public FakeProps Str(int id, string value)
    {
        Values[id] = value;
        return this;
    }

    public static WiaAttr List(params int[] values) => new() { IsList = true, Writable = true, Values = values, Nominal = values.FirstOrDefault() };
    public static WiaAttr Range(int min, int max, int step = 1, int nom = 0) => new() { IsRange = true, Writable = true, Min = min, Max = max, Step = step, Nominal = nom };

    public bool Has(int id) => Values.ContainsKey(id);
    public int? GetInt(int id) => Values.TryGetValue(id, out var v) && v is int i ? i : null;
    public string? GetString(int id) => Values.TryGetValue(id, out var v) ? v as string : null;
    public WiaAttr? GetAttr(int id) => Attrs.TryGetValue(id, out var a) ? a : (Has(id) ? new WiaAttr { Writable = true } : null);

    public bool TrySet(int id, int value)
    {
        if (!Has(id) || ReadOnly.Contains(id)) return false;
        if (Attrs.TryGetValue(id, out var a))
        {
            if (a.IsList && !a.Values.Contains(value)) return false;
            if (a.IsRange && (value < a.Min || value > a.Max)) return false;
        }
        Values[id] = value;
        Sets.Add((id, value));
        return true;
    }

    public int? SetValue(int id) => Sets.Where(s => s.Id == id).Select(s => (int?)s.Value).LastOrDefault();
}

public class WiaListTests
{
    private static FakeProps Info() => new FakeProps()
        .Str(DIP_DEV_ID, "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0001")
        .Str(DIP_DEV_NAME, "EPSON Perfection V39")
        .Str(DIP_VEND_DESC, "EPSON")
        .Str(DIP_DEV_DESC, "EPSON Perfection V39")
        .Int(DIP_DEV_TYPE, (1 << 16) | 3)
        .Str(DIP_PORT_NAME, @"\\.\Usbscan0")
        .Str(DIP_PNP_ID, @"USB\VID_04B8&PID_013D\L53010012345")
        .Str(DIP_WIA_VERSION, "2.0");

    [Fact]
    public void ListsAScanner()
    {
        var s = WiaMapping.ToScanner(Info())!;
        Assert.Equal("wia:{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0001", s.Id);
        Assert.Equal("EPSON Perfection V39", s.Name);
        Assert.Equal("wia", s.Driver);
        Assert.Equal("wia2", s.Api);
        Assert.Equal("EPSON", s.Make);
        Assert.Equal("usb", s.Connection);
        Assert.Equal("L53010012345", s.Instance);
        var json = Json.Write(s.ToJson());
        Assert.Contains("\"driver\":\"wia\"", json);
        Assert.Contains("\"connection\":\"usb\"", json);
    }

    [Fact]
    public void SkipsCamerasAndBrokenEntries()
    {
        Assert.Null(WiaMapping.ToScanner(Info().Int(DIP_DEV_TYPE, (2 << 16) | 1)));
        var noId = Info();
        noId.Values.Remove(DIP_DEV_ID);
        Assert.Null(WiaMapping.ToScanner(noId));
    }

    [Fact]
    public void NamesAScannerWithoutAFriendlyName()
    {
        Assert.Equal("EPSON Perfection V39", WiaMapping.ToScanner(Info().Str(DIP_DEV_NAME, "No friendly name"))!.Name);
        var bare = Info().Str(DIP_DEV_NAME, "").Str(DIP_DEV_DESC, "");
        Assert.Equal("Unknown scanner", WiaMapping.ToScanner(bare)!.Name);
    }

    [Fact]
    public void Wia1Drivers()
    {
        Assert.Equal("wia1", WiaMapping.ToScanner(Info().Str(DIP_WIA_VERSION, "1.0"))!.Api);
    }

    [Theory]
    [InlineData(@"\\.\Usbscan2", null, "usb")]
    [InlineData(null, @"USB\VID_04A9&PID_1913\5&1", "usb")]
    [InlineData("http://192.168.1.20:80/WSD/DEVICE", null, "network")]
    [InlineData(null, @"SWD\DAFWSDProvider\urn:uuid:4509a320", "network")]
    [InlineData("192.168.1.31", null, "network")]
    [InlineData("COM1", null, "unknown")]
    [InlineData(null, null, "unknown")]
    public void Connection(string? port, string? pnp, string expected)
    {
        Assert.Equal(expected, WiaMapping.Connection(port, pnp));
    }
}

public class WiaCapsTests
{
    private static FakeProps Device(int handling = FLATBED | FEEDER | DUPLEX) => new FakeProps()
        .Int(DPS_DOCUMENT_HANDLING_CAPABILITIES, handling)
        .Int(DPS_DOCUMENT_HANDLING_STATUS, FEED_READY)
        .Int(DPS_HORIZONTAL_BED_SIZE, 8500)
        .Int(DPS_VERTICAL_BED_SIZE, 11690);

    private static FakeProps Flatbed() => new FakeProps()
        .Int(IPS_XRES, 300, FakeProps.List(75, 150, 300, 600, 1200))
        .Int(IPS_YRES, 300, FakeProps.List(75, 150, 300, 600))
        .Int(IPA_DATATYPE, DATA_COLOR, FakeProps.List(DATA_THRESHOLD, DATA_GRAYSCALE, DATA_COLOR))
        .Int(IPS_MAX_HORIZONTAL_SIZE, 8500)
        .Int(IPS_MAX_VERTICAL_SIZE, 11690)
        .Int(IPS_MIN_HORIZONTAL_SIZE, 100)
        .Int(IPS_MIN_VERTICAL_SIZE, 100)
        .Int(IPS_BRIGHTNESS, 0, FakeProps.Range(-1000, 1000, 1, 0))
        .Int(IPS_CONTRAST, 0, FakeProps.Range(-1000, 1000, 1, 0))
        .Int(IPS_THRESHOLD, 128, FakeProps.Range(0, 255, 1, 128))
        .Int(IPS_PAGE_SIZE, 1, FakeProps.List(0, 1, 2, 100))
        .Int(IPS_AUTO_DESKEW, AUTO_DESKEW_OFF, FakeProps.List(AUTO_DESKEW_ON, AUTO_DESKEW_OFF))
        .Int(IPS_PREVIEW, FINAL_SCAN, FakeProps.List(FINAL_SCAN, PREVIEW_SCAN));

    private static FakeProps Feeder() => new FakeProps()
        .Int(IPS_XRES, 200, FakeProps.Range(50, 600, 50, 200))
        .Int(IPS_YRES, 200, FakeProps.Range(50, 600, 50, 200))
        .Int(IPA_DATATYPE, DATA_GRAYSCALE, FakeProps.List(DATA_GRAYSCALE, DATA_COLOR))
        .Int(IPS_MAX_HORIZONTAL_SIZE, 8500)
        .Int(IPS_MAX_VERTICAL_SIZE, 14000)
        .Int(IPS_DOCUMENT_HANDLING_SELECT, FRONT_ONLY, new WiaAttr { IsFlag = true, Writable = true })
        .Int(IPS_PAGES, 1, FakeProps.Range(0, 100))
        .Int(IPS_PAGE_SIZE, 0, FakeProps.List(0, 1, 3, 2))
        .Int(IPS_BLANK_PAGES, 0, FakeProps.List(BLANK_PAGE_DETECTION_DISABLED, BLANK_PAGE_DISCARD))
        .Int(IPS_MULTI_FEED, 0, FakeProps.List(MULTI_FEED_DETECT_DISABLED, MULTI_FEED_DETECT_STOP_ERROR))
        .Int(IPS_AUTO_CROP, 0, FakeProps.List(AUTO_CROP_DISABLED, AUTO_CROP_SINGLE))
        .Int(IPS_SHEET_FEEDER_REGISTRATION, CENTERED);

    [Fact]
    public void FlatbedCaps()
    {
        var c = WiaMapping.SourceCaps(Device(), Flatbed(), "flatbed", false);
        Assert.Equal("flatbed", c.Id);
        Assert.False(c.Duplex);
        Assert.True(c.CanPreview);
        // Only resolutions valid both ways
        Assert.Equal(new[] { 75, 150, 300, 600 }, c.Resolutions);
        Assert.Equal(new[] { "color", "gray", "bw" }, c.Colors);
        Assert.Equal(8.5, c.MaxWidth);
        Assert.Equal(11.69, c.MaxHeight);
        Assert.Equal(0.1, c.MinWidth);
        Assert.Equal(new[] { "A4", "Letter" }, c.PaperSizes.Select(p => p.Name));
        Assert.True(c.AutoSize);
        Assert.True(c.AutoDeskew);
        Assert.False(c.AutoCrop);
        Assert.False(c.BlankPageSkip);
        Assert.True(c.Invert);
        Assert.Equal(-1000, c.Brightness!.Min);
        Assert.Equal(255, c.Threshold!.Max);
        Assert.Equal(128, c.Threshold.Default);
        Assert.Null(c.FeederLoaded);
    }

    [Fact]
    public void FeederCaps()
    {
        var c = WiaMapping.SourceCaps(Device(), Feeder(), "feeder", false);
        Assert.True(c.Duplex);
        Assert.False(c.CanPreview);
        Assert.Null(c.Resolutions);
        Assert.Equal(50, c.ResolutionRange!.Min);
        Assert.Equal(600, c.ResolutionRange.Max);
        Assert.Equal(50, c.ResolutionRange.Step);
        Assert.Equal(new[] { "color", "gray" }, c.Colors);
        Assert.False(c.Invert);
        Assert.Null(c.Threshold);
        Assert.Equal(new[] { "A4", "Letter", "Legal" }, c.PaperSizes.Select(p => p.Name));
        Assert.False(c.AutoSize);
        Assert.True(c.AutoCrop);
        Assert.True(c.BlankPageSkip);
        Assert.True(c.DoubleFeed);
        Assert.True(c.FeederLoaded);
        Assert.Null(c.Brightness);
    }

    [Fact]
    public void FeederWithoutPaper()
    {
        var device = Device().Int(DPS_DOCUMENT_HANDLING_STATUS, 0);
        Assert.False(WiaMapping.SourceCaps(device, Feeder(), "feeder", false).FeederLoaded);
    }

    [Fact]
    public void Wia1SizesComeFromTheDevice()
    {
        var device = Device(FLATBED | FEEDER)
            .Int(DPS_HORIZONTAL_SHEET_FEED_SIZE, 8500)
            .Int(DPS_VERTICAL_SHEET_FEED_SIZE, 14000)
            .Int(DPS_MIN_HORIZONTAL_SHEET_FEED_SIZE, 2000)
            .Int(DPS_MIN_VERTICAL_SHEET_FEED_SIZE, 3000);
        var item = new FakeProps()
            .Int(IPS_XRES, 300, FakeProps.Range(75, 1200, 1, 300))
            // On WIA 1.0, 3107 isn't "auto deskew"
            .Int(IPS_AUTO_DESKEW, 0, FakeProps.List(0, 1));
        var flatbed = WiaMapping.SourceCaps(device, item, "flatbed", true);
        Assert.Equal(8.5, flatbed.MaxWidth);
        Assert.Equal(11.69, flatbed.MaxHeight);
        Assert.False(flatbed.AutoDeskew);
        var feeder = WiaMapping.SourceCaps(device, item, "feeder", true);
        Assert.Equal(14, feeder.MaxHeight);
        Assert.Equal(2, feeder.MinWidth);
        Assert.Equal(3, feeder.MinHeight);
        Assert.False(feeder.Duplex);
        Assert.Contains("Legal", feeder.PaperSizes.Select(p => p.Name));
    }

    [Fact]
    public void SizesFromTheExtentWhenNothingElse()
    {
        var item = new FakeProps()
            .Int(IPS_XRES, 200)
            .Int(IPS_YRES, 200)
            .Int(IPS_XEXTENT, 1700, FakeProps.Range(10, 1700))
            .Int(IPS_YEXTENT, 2338, FakeProps.Range(10, 2338));
        var c = WiaMapping.SourceCaps(new FakeProps(), item, "flatbed", false);
        Assert.Equal(8.5, c.MaxWidth);
        Assert.Equal(11.69, c.MaxHeight);
        Assert.Equal(0.05, c.MinWidth);
        Assert.Equal(new[] { 200 }, c.Resolutions);
        // A driver that doesn't list color modes is offered them all
        Assert.Equal(new[] { "color", "gray", "bw" }, c.Colors);
    }

    [Fact]
    public void CapsJsonFollowsTheContract()
    {
        var json = Json.Write(WiaMapping.SourceCaps(Device(), Feeder(), "feeder", false).ToJson());
        foreach (var key in new[]
        {
            "id", "duplex", "resolutions", "colors", "maxWidth", "maxHeight", "minWidth", "minHeight", "canPreview",
            "paperSizes", "autoSize", "autoDeskew", "autoCrop", "blankPageSkip", "doubleFeed", "invert", "brightness",
            "contrast", "threshold", "feederLoaded",
        })
            Assert.Contains("\"" + key + "\":", json);
        Assert.Contains("\"resolutions\":{\"min\":50,\"max\":600,\"step\":50}", json);
        Assert.Contains("\"brightness\":null", json);
        Assert.Contains("{\"name\":\"A4\",\"width\":8.267,\"height\":11.692}", json);
    }
}

public class WiaConfigureTests
{
    private static FakeProps Device() => new FakeProps()
        .Int(DPS_DOCUMENT_HANDLING_CAPABILITIES, FLATBED | FEEDER | DUPLEX)
        .Int(DPS_DOCUMENT_HANDLING_SELECT, FLATBED)
        .Int(DPS_PAGES, 1)
        .Int(DPS_HORIZONTAL_BED_REGISTRATION, LEFT_JUSTIFIED)
        .Int(DPS_HORIZONTAL_BED_SIZE, 8500)
        .Int(DPS_VERTICAL_BED_SIZE, 11690)
        .Int(DPS_HORIZONTAL_SHEET_FEED_SIZE, 8500)
        .Int(DPS_VERTICAL_SHEET_FEED_SIZE, 14000);

    private static FakeProps Item(bool feeder = false) => new FakeProps()
        .Int(IPS_XRES, 150, FakeProps.List(75, 150, 300, 600))
        .Int(IPS_YRES, 150, FakeProps.List(75, 150, 300, 600))
        .Int(IPA_DATATYPE, DATA_COLOR, FakeProps.List(DATA_DITHER, DATA_GRAYSCALE, DATA_COLOR))
        .Int(IPS_MAX_HORIZONTAL_SIZE, 8500)
        .Int(IPS_MAX_VERTICAL_SIZE, feeder ? 14000 : 11690)
        .Int(IPS_XPOS, 100)
        .Int(IPS_YPOS, 0)
        .Int(IPS_XEXTENT, 1000, FakeProps.Range(1, 5100))
        .Int(IPS_YEXTENT, 1000, FakeProps.Range(1, feeder ? 8400 : 7014))
        .Int(IPS_BRIGHTNESS, 0, FakeProps.Range(-100, 100, 5))
        .Int(IPS_CONTRAST, 0, FakeProps.Range(-100, 100, 5))
        .Int(IPS_THRESHOLD, 128, FakeProps.Range(0, 255))
        .Int(IPS_PAGE_SIZE, 1, FakeProps.List(0, 1, 2, 100))
        .Int(IPS_PREVIEW, FINAL_SCAN)
        .Int(IPS_AUTO_DESKEW, AUTO_DESKEW_OFF)
        .Int(IPS_BLANK_PAGES, 0)
        .Int(IPS_MULTI_FEED, 0)
        .Int(IPS_AUTO_CROP, 0)
        .Int(IPS_DOCUMENT_HANDLING_SELECT, FRONT_ONLY)
        .Int(IPS_PAGES, 1)
        .Int(IPS_SHEET_FEEDER_REGISTRATION, CENTERED);

    private static ScanOptions Opts(string json) => ScanOptions.FromJson(json);

    [Fact]
    public void FlatbedArea()
    {
        var item = Item();
        var setup = WiaMapping.Configure(Device(), item, Opts("{\"source\":\"flatbed\",\"color\":\"gray\",\"dpi\":310,\"area\":{\"x\":1,\"y\":2,\"width\":4,\"height\":5}}"), false, false);
        Assert.Equal(300, setup.Dpi);
        Assert.False(setup.Duplex);
        Assert.Equal(DATA_GRAYSCALE, item.SetValue(IPA_DATATYPE));
        Assert.Equal(300, item.SetValue(IPS_XRES));
        Assert.Equal(300, item.SetValue(IPS_YRES));
        Assert.Equal(PaperSizes.WiaPageCustom, item.SetValue(IPS_PAGE_SIZE));
        Assert.Equal(1200, item.SetValue(IPS_XEXTENT));
        Assert.Equal(1500, item.SetValue(IPS_YEXTENT));
        Assert.Equal(300, item.SetValue(IPS_XPOS));
        Assert.Equal(600, item.SetValue(IPS_YPOS));
        Assert.Equal(FINAL_SCAN, item.SetValue(IPS_PREVIEW));
        // Positions go to 0 before the extents, so the old position can't make them invalid
        var order = item.Sets.Select(s => s.Id).ToList();
        Assert.True(order.IndexOf(IPS_XPOS) < order.IndexOf(IPS_XEXTENT));
        Assert.True(order.LastIndexOf(IPS_XPOS) > order.IndexOf(IPS_XEXTENT));
        // Flatbed scans leave the feeder settings alone
        Assert.Null(item.SetValue(IPS_DOCUMENT_HANDLING_SELECT));
        Assert.Null(item.SetValue(IPS_PAGES));
    }

    [Fact]
    public void ColorAndResolutionFirst()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"color\":\"color\",\"dpi\":600,\"paper\":{\"width\":8.5,\"height\":11}}"), false, false);
        var order = item.Sets.Select(s => s.Id).ToList();
        Assert.True(order.IndexOf(IPA_DATATYPE) < order.IndexOf(IPS_XRES));
        Assert.True(order.IndexOf(IPS_XRES) < order.IndexOf(IPS_XEXTENT));
    }

    [Fact]
    public void FeederDuplexAllPagesCentredPaper()
    {
        var item = Item(feeder: true);
        var setup = WiaMapping.Configure(Device(), item,
            Opts("{\"source\":\"feeder\",\"duplex\":true,\"dpi\":200,\"paper\":{\"width\":8.27,\"height\":11.69},\"blankPageSkip\":true,\"doubleFeedStop\":true}"),
            false, false);
        Assert.True(setup.Duplex);
        Assert.False(setup.BackFirst);
        Assert.Equal(DUPLEX, item.SetValue(IPS_DOCUMENT_HANDLING_SELECT));
        Assert.Equal(0, item.SetValue(IPS_PAGES));
        // 200 isn't in the list: the nearest is used
        Assert.Equal(150, setup.Dpi);
        // Centred: (8.5 - 8.27) / 2 inches in
        Assert.Equal(17, item.SetValue(IPS_XPOS));
        Assert.Equal(1241, item.SetValue(IPS_XEXTENT));
        Assert.Equal(1754, item.SetValue(IPS_YEXTENT));
        Assert.Equal(BLANK_PAGE_DISCARD, item.SetValue(IPS_BLANK_PAGES));
        Assert.Equal(MULTI_FEED_DETECT_STOP_ERROR, item.SetValue(IPS_MULTI_FEED));
    }

    [Fact]
    public void FrontOnlyFeeder()
    {
        var item = Item(feeder: true);
        WiaMapping.Configure(Device(), item, Opts("{\"source\":\"feeder\"}"), false, false);
        Assert.Equal(FRONT_ONLY, item.SetValue(IPS_DOCUMENT_HANDLING_SELECT));
        // Nothing asked for: the scanner's own settings stay
        Assert.Null(item.SetValue(IPS_XRES));
        Assert.Null(item.SetValue(IPS_BLANK_PAGES));
        Assert.Null(item.SetValue(IPS_AUTO_DESKEW));
        Assert.Null(item.SetValue(IPS_BRIGHTNESS));
        Assert.Null(item.SetValue(IPS_PAGE_SIZE));
        Assert.Null(item.SetValue(IPS_XEXTENT));
    }

    [Fact]
    public void BackFirstDrivers()
    {
        var item = Item(feeder: true);
        item.ReadOnly.Add(IPS_DOCUMENT_HANDLING_SELECT);
        item.Int(IPS_DOCUMENT_HANDLING_SELECT, DUPLEX | BACK_FIRST);
        Assert.True(WiaMapping.Configure(Device(), item, Opts("{\"source\":\"feeder\",\"duplex\":true}"), false, false).BackFirst);
    }

    [Fact]
    public void BlackAndWhiteFallsBackToDither()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"color\":\"bw\",\"threshold\":300}"), false, false);
        Assert.Equal(DATA_DITHER, item.SetValue(IPA_DATATYPE));
        Assert.Equal(255, item.SetValue(IPS_THRESHOLD));
    }

    [Fact]
    public void ThresholdOnlyForBlackAndWhite()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"color\":\"gray\",\"threshold\":100}"), false, false);
        Assert.Null(item.SetValue(IPS_THRESHOLD));
    }

    [Fact]
    public void BrightnessAndContrastSnapToTheDriversRange()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"brightness\":42,\"contrast\":-500}"), false, false);
        Assert.Equal(40, item.SetValue(IPS_BRIGHTNESS));
        Assert.Equal(-100, item.SetValue(IPS_CONTRAST));
    }

    [Fact]
    public void AutoSizeUsesThePageSizeSetting()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"area\":\"auto\",\"dpi\":300}"), false, false);
        Assert.Equal(PaperSizes.WiaPageAuto, item.SetValue(IPS_PAGE_SIZE));
        // The driver decides the area
        Assert.Null(item.SetValue(IPS_XEXTENT));
    }

    [Fact]
    public void AutoSizeFallsBackToAutoCrop()
    {
        var item = Item();
        item.Attrs[IPS_PAGE_SIZE] = FakeProps.List(0, 1, 2);
        item.Attrs[IPS_AUTO_CROP] = FakeProps.List(AUTO_CROP_DISABLED, AUTO_CROP_SINGLE);
        WiaMapping.Configure(Device(), item, Opts("{\"area\":\"auto\"}"), false, false);
        Assert.Equal(AUTO_CROP_SINGLE, item.SetValue(IPS_AUTO_CROP));
    }

    [Fact]
    public void DeskewOnRequest()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"autoDeskew\":true}"), false, false);
        Assert.Equal(AUTO_DESKEW_ON, item.SetValue(IPS_AUTO_DESKEW));
    }

    [Fact]
    public void PreviewFlag()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"source\":\"flatbed\",\"dpi\":75}"), false, true);
        Assert.Equal(PREVIEW_SCAN, item.SetValue(IPS_PREVIEW));
        // The whole glass, in whole pixels
        Assert.Equal(637, item.SetValue(IPS_XEXTENT));
        Assert.Equal(876, item.SetValue(IPS_YEXTENT));
    }

    [Fact]
    public void OffsetWidthDrivers()
    {
        var item = Item();
        WiaMapping.Configure(Device(), item, Opts("{\"dpi\":300,\"area\":{\"x\":1,\"y\":0,\"width\":2,\"height\":2},\"offsetWidth\":true}"), false, false);
        Assert.Equal(300, item.SetValue(IPS_XPOS));
        Assert.Equal(900, item.SetValue(IPS_XEXTENT));
    }

    [Fact]
    public void ExtentsStayWithinTheDriversLimit()
    {
        var item = Item();
        item.Attrs[IPS_XEXTENT] = FakeProps.Range(1, 2400);
        WiaMapping.Configure(Device(), item, Opts("{\"dpi\":300,\"paper\":{\"width\":8.5,\"height\":11}}"), false, false);
        Assert.Equal(2400, item.SetValue(IPS_XEXTENT));
    }

    [Fact]
    public void Wia1FeederIsChosenOnTheDevice()
    {
        var device = Device();
        var item = new FakeProps()
            .Int(IPS_XRES, 150, FakeProps.Range(50, 600))
            .Int(IPS_YRES, 150, FakeProps.Range(50, 600))
            .Int(IPS_XPOS, 0)
            .Int(IPS_YPOS, 0)
            .Int(IPS_XEXTENT, 100)
            .Int(IPS_YEXTENT, 100)
            .Int(IPS_PAGE_SIZE, 0)
            .Int(IPS_BLANK_PAGES, 0);
        var setup = WiaMapping.Configure(device, item, Opts("{\"source\":\"feeder\",\"duplex\":true,\"dpi\":300,\"paper\":{\"width\":8.5,\"height\":14},\"blankPageSkip\":true}"), true, false);
        Assert.Equal(FEEDER | DUPLEX, device.SetValue(DPS_DOCUMENT_HANDLING_SELECT));
        Assert.Equal(1, device.SetValue(DPS_PAGES));
        Assert.Equal(300, setup.Dpi);
        Assert.Equal(2550, item.SetValue(IPS_XEXTENT));
        Assert.Equal(4200, item.SetValue(IPS_YEXTENT));
        // WIA 2.0-only settings aren't touched on WIA 1.0
        Assert.Null(item.SetValue(IPS_PAGE_SIZE));
        Assert.Null(item.SetValue(IPS_BLANK_PAGES));
    }

    [Fact]
    public void Wia1Flatbed()
    {
        var device = Device();
        WiaMapping.Configure(device, Item(), Opts("{\"source\":\"flatbed\"}"), true, false);
        Assert.Equal(FLATBED, device.SetValue(DPS_DOCUMENT_HANDLING_SELECT));
        Assert.Null(device.SetValue(DPS_PAGES));
    }

    [Fact]
    public void RefusedSettingsDontStopTheScan()
    {
        var item = Item();
        foreach (var id in item.Values.Keys.ToList()) item.ReadOnly.Add(id);
        var setup = WiaMapping.Configure(Device(), item, Opts("{\"color\":\"bw\",\"dpi\":300,\"area\":\"auto\",\"brightness\":10}"), false, false);
        Assert.Equal(150, setup.Dpi);
        Assert.Empty(item.Sets);
    }

    [Fact]
    public void ClosestResolutionOrCurrent()
    {
        var item = Item();
        Assert.Equal(600, WiaMapping.SetResolution(item, IPS_XRES, 1000));
        Assert.Equal(600, WiaMapping.SetResolution(item, IPS_XRES, null));
        item.Attrs[IPS_YRES] = FakeProps.Range(100, 1200, 100);
        Assert.Equal(400, WiaMapping.SetResolution(item, IPS_YRES, 420));
    }
}
