using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using Xunit;

namespace Paperwing.Scan.Tests;

public class StripImageTests
{
    [Fact]
    public void ColorStripsBecomeOnePage()
    {
        // 2 × 3 pixels, RGB, sent as two strips with padded rows
        var strip = new StripImage(2, 3, 24, false);
        strip.Add(new byte[] { 255, 0, 0, 0, 255, 0, 9, 9, 0, 0, 255, 10, 20, 30, 7, 7 }, 2, 2, 0, 0, 8);
        Assert.False(strip.Complete);
        strip.Add(new byte[] { 1, 2, 3, 4, 5, 6 }, 2, 1, 0, 2, 6);
        Assert.True(strip.Complete);
        using var bmp = strip.ToBitmap(300);
        Assert.Equal(PixelFormat.Format24bppRgb, bmp.PixelFormat);
        Assert.Equal(Color.FromArgb(255, 0, 0), bmp.GetPixel(0, 0));
        Assert.Equal(Color.FromArgb(0, 255, 0), bmp.GetPixel(1, 0));
        Assert.Equal(Color.FromArgb(0, 0, 255), bmp.GetPixel(0, 1));
        Assert.Equal(Color.FromArgb(10, 20, 30), bmp.GetPixel(1, 1));
        Assert.Equal(Color.FromArgb(4, 5, 6), bmp.GetPixel(1, 2));
        Assert.Equal(300, bmp.HorizontalResolution);
    }

    [Fact]
    public void BlackAndWhiteFollowsThePixelFlavor()
    {
        // One row of 8 pixels: 0b10100000
        var chocolate = new StripImage(8, 1, 1, false);
        chocolate.Add(new byte[] { 0xA0, 0, 0, 0 }, 8, 1, 0, 0, 4);
        using var c = chocolate.ToBitmap(200);
        Assert.Equal(PixelFormat.Format1bppIndexed, c.PixelFormat);
        Assert.Equal(255, c.GetPixel(0, 0).R);
        Assert.Equal(0, c.GetPixel(1, 0).R);

        var vanilla = new StripImage(8, 1, 1, true);
        vanilla.Add(new byte[] { 0xA0, 0, 0, 0 }, 8, 1, 0, 0, 4);
        using var v = vanilla.ToBitmap(200);
        Assert.Equal(0, v.GetPixel(0, 0).R);
        Assert.Equal(255, v.GetPixel(1, 0).R);
    }

    [Fact]
    public void GreyPages()
    {
        var strip = new StripImage(4, 1, 8, false);
        strip.Add(new byte[] { 0, 85, 170, 255 }, 4, 1, 0, 0, 4);
        using var bmp = strip.ToBitmap(0);
        Assert.Equal(PixelFormat.Format8bppIndexed, bmp.PixelFormat);
        Assert.Equal(new[] { 0, 85, 170, 255 }, Enumerable.Range(0, 4).Select(x => (int)bmp.GetPixel(x, 0).R));
    }

    [Fact]
    public void PagesOfUnknownLengthGrow()
    {
        var strip = new StripImage(3, -1, 8, false);
        for (var y = 0; y < 1000; y += 10)
            strip.Add(Enumerable.Repeat((byte)(y / 10), 4 * 10).ToArray(), 3, 10, 0, y, 4);
        Assert.False(strip.Complete);
        Assert.Equal(1000, strip.Height);
        using var bmp = strip.ToBitmap(0);
        Assert.Equal(3, bmp.Width);
        Assert.Equal(1000, bmp.Height);
        Assert.Equal(99, bmp.GetPixel(2, 999).R);
    }

    [Fact]
    public void StripsWithoutAWidth()
    {
        // Kyocera drivers leave out the width and the strip's column count
        var strip = new StripImage(0, 2, 8, false);
        strip.Add(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, 0, 2, 0, 0, 4);
        Assert.True(strip.Complete);
        using var bmp = strip.ToBitmap(0);
        Assert.Equal(4, bmp.Width);
        Assert.Equal(8, bmp.GetPixel(3, 1).R);
    }

    [Fact]
    public void Tiles()
    {
        var strip = new StripImage(4, 2, 8, false);
        strip.Add(new byte[] { 1, 2, 3, 4 }, 2, 2, 0, 0, 2);
        strip.Add(new byte[] { 5, 6, 7, 8 }, 2, 2, 2, 0, 2);
        using var bmp = strip.ToBitmap(0);
        Assert.Equal(new[] { 1, 2, 5, 6 }, Enumerable.Range(0, 4).Select(x => (int)bmp.GetPixel(x, 0).R));
        Assert.Equal(new[] { 3, 4, 7, 8 }, Enumerable.Range(0, 4).Select(x => (int)bmp.GetPixel(x, 1).R));
    }

    [Fact]
    public void UnusualPixelsAreUnsupported()
    {
        Assert.Equal(ErrorCodes.Unsupported, Assert.Throws<ScanException>(() => new StripImage(10, 10, 48, false)).Code);
        Assert.Throws<InvalidOperationException>(() => new StripImage(10, 10, 8, false).ToBitmap(0));
    }
}

public class ImagingTests
{
    [Fact]
    public void InvertsBlackAndWhiteThroughThePalette()
    {
        using var bmp = new Bitmap(8, 1, PixelFormat.Format1bppIndexed);
        Assert.Equal(0, bmp.GetPixel(0, 0).R);
        Assert.True(Imaging.InvertIndexed(bmp));
        Assert.Equal(255, bmp.GetPixel(0, 0).R);
        using var color = new Bitmap(1, 1, PixelFormat.Format24bppRgb);
        Assert.False(Imaging.InvertIndexed(color));
    }

    [Fact]
    public void ReadsBelievableResolutions()
    {
        using var bmp = new Bitmap(1, 1);
        bmp.SetResolution(300, 300);
        Assert.Equal(300, Imaging.ResolutionOf(bmp));
        bmp.SetResolution(96, 96);
        Assert.Equal(0, Imaging.ResolutionOf(bmp));
    }
}

public sealed class ScanJobTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "pw-scan-test-" + Guid.NewGuid().ToString("N"));
    private readonly MemoryStream _stdout = new();

    public ScanJobTests()
    {
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        Directory.Delete(_dir, true);
    }

    private List<Dictionary<string, object?>> Lines() =>
        Encoding.UTF8.GetString(_stdout.ToArray()).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(l => (Dictionary<string, object?>)Json.Parse(l)!).ToList();

    private ScanJob Job(string optionsJson = "{}") =>
        new(new Output(_stdout), _dir, ScanOptions.FromJson(optionsJson), false, IntPtr.Zero);

    [Fact]
    public void PagesArePngFilesInOutDirAndReported()
    {
        using (var job = Job())
        {
            using var bmp = new Bitmap(40, 60, PixelFormat.Format24bppRgb);
            job.AddPage(bmp, 300, "front");
            job.AddPage(bmp, 300, "back");
            Assert.Equal(2, job.Pages);
        }
        var lines = Lines();
        Assert.Equal(2, lines.Count);
        Assert.Equal("page", lines[0]["type"]);
        Assert.Equal(Path.Combine(_dir, "page-0001.png"), lines[0]["file"]);
        Assert.Equal(300.0, lines[0]["dpi"]);
        Assert.Equal(40.0, lines[0]["width"]);
        Assert.Equal(60.0, lines[0]["height"]);
        Assert.Equal("front", lines[0]["side"]);
        Assert.Equal("back", lines[1]["side"]);
        Assert.Equal(new[] { "page-0001.png", "page-0002.png" }, Directory.GetFiles(_dir).Select(Path.GetFileName).OrderBy(f => f));
        using var saved = Image.FromFile(Path.Combine(_dir, "page-0001.png"));
        Assert.Equal(ImageFormat.Png, saved.RawFormat);
        Assert.Equal(300, (int)Math.Round(saved.HorizontalResolution));
    }

    [Fact]
    public void PagesFromImageFiles()
    {
        var bmpBytes = new MemoryStream();
        using (var bmp = new Bitmap(10, 20, PixelFormat.Format24bppRgb))
        {
            bmp.SetResolution(150, 150);
            bmp.Save(bmpBytes, ImageFormat.Bmp);
        }
        bmpBytes.Position = 0;
        using (var job = Job()) job.AddPage(bmpBytes, 0, "front");
        var page = Lines().Single();
        Assert.Equal(150.0, page["dpi"]);
        Assert.Equal(20.0, page["height"]);
    }

    [Fact]
    public void HalfAnImageIsAnOfflineError()
    {
        using var job = Job();
        var e = Assert.Throws<ScanException>(() => job.AddPage(new MemoryStream(new byte[] { 0x42, 0x4D, 1, 2, 3 }), 300, "front"));
        Assert.Equal(ErrorCodes.Offline, e.Code);
        Assert.Equal(0, job.Pages);
        Assert.Empty(Directory.GetFiles(_dir));
    }

    [Fact]
    public void InvertOption()
    {
        using (var job = Job("{\"invert\":true}"))
        {
            using var bmp = new Bitmap(8, 8, PixelFormat.Format1bppIndexed);
            job.AddPage(bmp, 200, "front");
        }
        using var saved = new Bitmap(Path.Combine(_dir, "page-0001.png"));
        Assert.Equal(255, saved.GetPixel(0, 0).R);
    }

    [Fact]
    public void MultiPageTiffs()
    {
        var tiff = Path.Combine(_dir, "driver.tif");
        using (var first = new Bitmap(10, 10, PixelFormat.Format24bppRgb))
        using (var second = new Bitmap(10, 10, PixelFormat.Format24bppRgb))
        {
            var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Tiff.Guid);
            var ps = new EncoderParameters(1);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.SaveFlag, (long)EncoderValue.MultiFrame);
            first.Save(tiff, codec, ps);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.SaveFlag, (long)EncoderValue.FrameDimensionPage);
            first.SaveAdd(second, ps);
            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.SaveFlag, (long)EncoderValue.Flush);
            first.SaveAdd(ps);
        }
        using (var job = Job()) job.AddPagesFromFile(tiff);
        Assert.Equal(2, Lines().Count);
    }

    [Fact]
    public void CancelIsRaisedOnce()
    {
        using var job = Job();
        var raised = 0;
        job.Cancelled += () => raised++;
        job.RequestCancel();
        job.RequestCancel();
        Assert.True(job.CancelRequested);
        Assert.Equal(1, raised);
    }

    [Fact]
    public void OutDirMustExist()
    {
        Assert.Equal(ErrorCodes.Failed, Assert.Throws<ScanException>(() => ScanJob.CheckOutDir(Path.Combine(_dir, "missing"))).Code);
        Assert.Throws<ScanException>(() => ScanJob.CheckOutDir(" "));
        Assert.Equal(_dir, ScanJob.CheckOutDir(_dir + Path.DirectorySeparatorChar));
    }

    [Fact]
    public void DriverFilesAreCleanedUp()
    {
        string folder;
        using (var job = Job())
        {
            folder = job.DriverFolder();
            File.WriteAllText(Path.Combine(folder, "x.bmp"), "x");
            Assert.StartsWith(_dir, folder);
        }
        Assert.False(Directory.Exists(folder));
    }
}
