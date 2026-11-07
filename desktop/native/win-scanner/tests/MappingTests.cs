using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Xunit;

namespace Paperwing.Scan.Tests;

public class OptionsTests
{
    private static string B64(string json) => Convert.ToBase64String(Encoding.UTF8.GetBytes(json));

    [Fact]
    public void AbsentMeansScannerDefault()
    {
        foreach (var o in new[] { ScanOptions.Parse(null), ScanOptions.Parse(""), ScanOptions.Parse(B64("{}")) })
        {
            Assert.Null(o.Source);
            Assert.Null(o.Color);
            Assert.Null(o.Dpi);
            Assert.Null(o.Area);
            Assert.Null(o.Paper);
            Assert.False(o.AutoArea);
            Assert.Null(o.Brightness);
            Assert.Null(o.AutoDeskew);
            Assert.False(o.Duplex);
            Assert.False(o.NativeUi);
            Assert.Null(o.Transfer);
        }
    }

    [Fact]
    public void ReadsEveryOption()
    {
        var o = ScanOptions.Parse(B64(
            "{\"source\":\"feeder\",\"duplex\":true,\"color\":\"bw\",\"dpi\":600,\"area\":{\"x\":0.5,\"y\":1,\"width\":4,\"height\":5.5}," +
            "\"brightness\":-200,\"contrast\":150,\"threshold\":128,\"autoDeskew\":true,\"blankPageSkip\":false," +
            "\"doubleFeedStop\":true,\"invert\":true,\"nativeUi\":false,\"transfer\":\"native\",\"offsetWidth\":true}"));
        Assert.True(o.Feeder);
        Assert.True(o.Duplex);
        Assert.Equal("bw", o.Color);
        Assert.Equal(600, o.Dpi);
        Assert.Equal(new RectIn(0.5, 1, 4, 5.5), o.Area!.Value);
        Assert.Equal(-200, o.Brightness);
        Assert.Equal(150, o.Contrast);
        Assert.Equal(128, o.Threshold);
        Assert.True(o.AutoDeskew);
        Assert.False(o.BlankPageSkip);
        Assert.True(o.DoubleFeedStop);
        Assert.True(o.Invert);
        Assert.Equal("native", o.Transfer);
        Assert.True(o.OffsetWidth);
    }

    [Fact]
    public void PaperAndAuto()
    {
        var paper = ScanOptions.FromJson("{\"paper\":{\"width\":8.27,\"height\":11.69}}");
        Assert.Equal(new RectIn(0, 0, 8.27, 11.69), paper.Paper!.Value);
        Assert.True(ScanOptions.FromJson("{\"area\":\"auto\"}").AutoArea);
        Assert.True(ScanOptions.FromJson("{\"paper\":\"auto\"}").AutoArea);
    }

    [Theory]
    [InlineData("{\"source\":\"glass\"}")]
    [InlineData("{\"color\":\"rgb\"}")]
    [InlineData("{\"dpi\":300.5}")]
    [InlineData("{\"dpi\":5}")]
    [InlineData("{\"dpi\":\"300\"}")]
    [InlineData("{\"duplex\":1}")]
    [InlineData("{\"area\":{\"x\":0,\"y\":0,\"width\":0,\"height\":1}}")]
    [InlineData("{\"area\":{\"x\":-1,\"y\":0,\"width\":1,\"height\":1}}")]
    [InlineData("{\"area\":{\"x\":0,\"y\":0,\"width\":1}}")]
    [InlineData("{\"area\":\"everything\"}")]
    [InlineData("{\"transfer\":\"file\"}")]
    [InlineData("[]")]
    [InlineData("not json")]
    public void RejectsBadOptions(string json)
    {
        var e = Assert.Throws<ScanException>(() => ScanOptions.FromJson(json));
        Assert.Equal(ErrorCodes.Failed, e.Code);
        Assert.StartsWith("Invalid scan options", e.Message);
    }

    [Fact]
    public void RejectsBadBase64()
    {
        Assert.Throws<ScanException>(() => ScanOptions.Parse("!!!"));
    }

    [Fact]
    public void PreviewIsTheWholeFlatbedOnce()
    {
        var o = ScanOptions.FromJson("{\"source\":\"feeder\",\"duplex\":true,\"color\":\"gray\",\"area\":\"auto\",\"blankPageSkip\":true,\"nativeUi\":true,\"brightness\":10}");
        var p = o.ForPreview(75);
        Assert.Equal("flatbed", p.Source);
        Assert.False(p.Duplex);
        Assert.Equal(75, p.Dpi);
        Assert.False(p.AutoArea);
        Assert.Null(p.Area);
        Assert.Null(p.BlankPageSkip);
        Assert.False(p.NativeUi);
        // The look of the page carries over
        Assert.Equal("gray", p.Color);
        Assert.Equal(10, p.Brightness);
        // The original is unchanged
        Assert.Equal("feeder", o.Source);
    }
}

public class GeometryTests
{
    private static ScanOptions Opts(string json) => ScanOptions.FromJson(json);

    [Fact]
    public void NoAreaMeansEverything()
    {
        Assert.Equal(new RectIn(0, 0, 8.5, 11.7), Geometry.ResolveArea(Opts("{}"), 8.5, 11.7, Align.Start, Align.Start));
    }

    [Fact]
    public void ExplicitAreaIsKeptInsideTheScanner()
    {
        Assert.Equal(new RectIn(1, 2, 3, 4), Geometry.ResolveArea(Opts("{\"area\":{\"x\":1,\"y\":2,\"width\":3,\"height\":4}}"), 8.5, 11.7, Align.Center, Align.Start));
        var clamped = Geometry.ResolveArea(Opts("{\"area\":{\"x\":7,\"y\":10,\"width\":3,\"height\":4}}"), 8.5, 11.7, Align.Start, Align.Start);
        Assert.Equal(7, clamped.X);
        Assert.Equal(1.5, clamped.Width, 6);
        Assert.Equal(1.7, clamped.Height, 6);
    }

    [Fact]
    public void PaperIsPlacedWhereTheScannerAlignsIt()
    {
        var a4 = Opts("{\"paper\":{\"width\":8.27,\"height\":11.69}}");
        Assert.Equal(0, Geometry.ResolveArea(a4, 8.5, 14, Align.Start, Align.Start).X);
        Assert.Equal(0.115, Geometry.ResolveArea(a4, 8.5, 14, Align.Center, Align.Start).X, 6);
        Assert.Equal(0.23, Geometry.ResolveArea(a4, 8.5, 14, Align.End, Align.Start).X, 6);
        var card = Opts("{\"paper\":{\"width\":3.5,\"height\":2}}");
        Assert.Equal(9.7, Geometry.ResolveArea(card, 8.5, 11.7, Align.Start, Align.End).Y, 6);
    }

    [Fact]
    public void PaperLargerThanTheScannerIsCut()
    {
        var legal = Geometry.ResolveArea(Opts("{\"paper\":{\"width\":8.5,\"height\":14}}"), 8.5, 11.7, Align.Center, Align.Start);
        Assert.Equal(new RectIn(0, 0, 8.5, 11.7), legal);
    }

    [Fact]
    public void UnknownLengthKeepsThePaper()
    {
        // Feeders often report no maximum length
        var r = Geometry.ResolveArea(Opts("{\"paper\":{\"width\":8.5,\"height\":14}}"), 8.5, 0, Align.Center, Align.Start);
        Assert.Equal(new RectIn(0, 0, 8.5, 14), r);
    }

    [Fact]
    public void WiaWindowInPixels()
    {
        var (x, y, w, h) = Geometry.WiaWindow(new RectIn(1, 0.5, 8.27, 11.69), 300, 300, 2550, 3508, false);
        Assert.Equal(300, x);
        Assert.Equal(150, y);
        Assert.Equal(2250, w); // 2481 cut to fit beside the offset
        Assert.Equal(3358, h);
    }

    [Fact]
    public void WiaWindowOffsetWidth()
    {
        var (x, _, w, _) = Geometry.WiaWindow(new RectIn(0.115, 0, 8.27, 11.69), 200, 200, 1700, 0, true);
        Assert.Equal(23, x);
        Assert.Equal(23 + 1654, w);
    }

    [Fact]
    public void WiaWindowWithoutKnownSize()
    {
        Assert.Equal((0, 0, 2550, 4200), Geometry.WiaWindow(new RectIn(0, 0, 8.5, 14), 300, 300, 0, 0, false));
    }

    [Fact]
    public void Conversions()
    {
        Assert.Equal(2550, Geometry.ToPixels(8.5, 300));
        Assert.Equal(3508, Geometry.ToPixels(11.693, 300));
        Assert.Equal(8.5, Geometry.FromThousandths(8500));
        Assert.Equal(2480, Geometry.ThousandthsToPixels(8267, 300));
        Assert.Equal(8.268, Geometry.Round(8.26771));
    }

    [Fact]
    public void ClosestResolution()
    {
        Assert.Equal(300, Geometry.Closest(310, new[] { 75, 150, 300, 600 }));
        Assert.Equal(600, Geometry.Closest(450, new[] { 75, 150, 300, 600 }));
        Assert.Equal(1200, Geometry.Closest(4800, new[] { 100, 1200 }));
        Assert.Equal(300, Geometry.Closest(300, Array.Empty<int>()));
    }

    [Fact]
    public void SnapIntoRange()
    {
        Assert.Equal(1000, Geometry.Snap(1500, -1000, 1000, 1));
        Assert.Equal(-1000, Geometry.Snap(-5000, -1000, 1000, 1));
        Assert.Equal(150, Geometry.Snap(160, 50, 1200, 50));
        Assert.Equal(1150, Geometry.Snap(1199, 50, 1199, 100));
        Assert.Equal(42.5, Geometry.Snap(42.5, 0, 100, 0));
        Assert.Equal(5, Geometry.Snap(5, 10, 0, 1));
    }

    [Fact]
    public void PreviewResolution()
    {
        Assert.Equal(75, Geometry.PreviewDpi(new[] { 75, 150, 300 }, null));
        Assert.Equal(100, Geometry.PreviewDpi(new[] { 25, 100, 200 }, null));
        Assert.Equal(75, Geometry.PreviewDpi(null, new RangeCap(50, 1200, 1, 300)));
        Assert.Equal(100, Geometry.PreviewDpi(null, new RangeCap(100, 1200, 100, 300)));
        Assert.Equal(75, Geometry.PreviewDpi(null, null));
    }
}

public class PaperSizesTests
{
    [Fact]
    public void WiaPageSizesThatFit()
    {
        // A4, Letter, custom, Legal, Ledger, business card, A3, auto
        var sizes = PaperSizes.FromWia(new[] { 0, 1, 2, 3, 4, 6, 10, 100 }, 8.5, 11.7);
        Assert.Equal(new[] { "A4", "Letter", "Business card" }, sizes.Select(s => s.Name));
        Assert.Equal(8.267, sizes[0].Width, 3);
        Assert.Equal(11.692, sizes[0].Height, 3);
    }

    [Fact]
    public void WiaIsoSeries()
    {
        var sizes = PaperSizes.FromWia(new[] { 7, 11, 12, 22, 33, 44 }, 0, 0);
        Assert.Equal(new[] { "A0", "A5", "A6", "B5 (ISO)", "C5", "B5 (JIS)" }, sizes.Select(s => s.Name));
    }

    [Fact]
    public void TwainSupportedSizes()
    {
        var sizes = PaperSizes.FromTwain(new[] { 0, 1, 3, 4, 2, 53, 11 }, 8.5, 14);
        Assert.Equal(new[] { "A4", "Letter", "Legal", "B5 (JIS)", "Business card" }, sizes.Select(s => s.Name));
    }

    [Fact]
    public void CommonSizesForAnA4Flatbed()
    {
        var names = PaperSizes.CommonFitting(8.5, 11.69).Select(s => s.Name).ToList();
        Assert.Contains("A4", names);
        Assert.Contains("Letter", names);
        Assert.DoesNotContain("Legal", names);
        Assert.DoesNotContain("A3", names);
        Assert.Equal(14, PaperSizes.CommonFitting(0, 0).Count);
    }
}

public class DeviceKeyTests
{
    [Theory]
    // TWAIN and WIA names for the same scanner give the same key
    [InlineData("Brother Industries, Ltd.", "TW-Brother MFC-L2710DW", "Brother", "Brother MFC-L2710DW series")]
    [InlineData("HP", "HP OfficeJet Pro 9010 series TWAIN", "HP", "HP OfficeJet Pro 9010 series")]
    [InlineData("Hewlett-Packard", "HP ScanJet Pro 2500 f1 TWAIN", "HP", "HP ScanJet Pro 2500 f1")]
    [InlineData("SEIKO EPSON CORPORATION", "EPSON Perfection V39", "EPSON", "EPSON Perfection V39")]
    [InlineData("Canon Inc.", "CanoScan LiDE 300 (64-bit)", "Canon", "Canon LiDE 300")]
    [InlineData("PFU LIMITED", "PaperStream IP fi-7160", "FUJITSU", "fi-7160")]
    [InlineData("Kodak Alaris", "KODAK Scanner: i1150", "Kodak", "Kodak i1150")]
    [InlineData("Xerox Corporation", "WIA-Xerox DocuMate 3125", "Xerox", "Xerox DocuMate 3125")]
    public void SameScannerSameKey(string twainMake, string twainModel, string wiaMake, string wiaModel)
    {
        Assert.Equal(DeviceKey.For(wiaMake, wiaModel, wiaModel), DeviceKey.For(twainMake, twainModel, twainModel));
    }

    [Fact]
    public void DifferentScannersDifferentKeys()
    {
        Assert.NotEqual(DeviceKey.For("Epson", "Perfection V39", null), DeviceKey.For("Epson", "Perfection V600", null));
        Assert.NotEqual(DeviceKey.For("Canon", "LiDE 300", null), DeviceKey.For("Epson", "LiDE 300", null));
    }

    [Fact]
    public void KeyShape()
    {
        Assert.Equal("brother:mfcl2710dw", DeviceKey.For("Brother", "Brother MFC-L2710DW series", null));
        Assert.Equal("twainworkinggroup:freeimagesoftware", DeviceKey.For("TWAIN Working Group", "TWAIN2 FreeImage Software Scanner", null));
        // Nothing but a name
        Assert.Equal("canon:lide400", DeviceKey.For("", "", "Canon LiDE 400"));
    }

    [Fact]
    public void IdenticalScannersStayApart()
    {
        var list = new List<ScannerInfo>
        {
            new("wia:1", "EPSON V39", "wia", "wia2", "EPSON", "EPSON V39", "usb") { Instance = "X1" },
            new("wia:2", "EPSON V39", "wia", "wia2", "EPSON", "EPSON V39", "usb") { Instance = "X2" },
            new("twain:EPSON V39", "EPSON V39", "twain", "twain64", "EPSON", "EPSON V39", "unknown"),
        };
        DeviceKey.Assign(list);
        Assert.Equal("epson:v39", list[0].DeviceKey);
        Assert.Equal("epson:v39#x2", list[1].DeviceKey);
        Assert.Equal("epson:v39", list[2].DeviceKey);
    }

    [Theory]
    [InlineData(@"USB\VID_04B8&PID_013A\L5GW001234", "L5GW001234")]
    [InlineData(@"USB\VID_04B8&PID_013A\5&2A5C3B1&0&2", null)]
    [InlineData(@"SWD\DAFWSDProvider\urn:uuid:4509a320-00a0-008f-00b6-002507510eca", null)]
    [InlineData(null, null)]
    public void UsbSerialNumbers(string? pnp, string? serial)
    {
        Assert.Equal(serial, DeviceKey.SerialFromPnpId(pnp));
    }
}
