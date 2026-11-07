using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Xunit;

namespace Paperwing.Scan.Tests;

public class JsonTests
{
    [Fact]
    public void WritesProtocolValues()
    {
        var json = Json.Write(new Dictionary<string, object?>
        {
            ["type"] = "page",
            ["dpi"] = 300,
            ["width"] = 8.5,
            ["whole"] = 11.0,
            ["ok"] = true,
            ["none"] = null,
            ["list"] = new List<int> { 1, 2 },
            ["nan"] = double.NaN,
        });
        Assert.Equal("{\"type\":\"page\",\"dpi\":300,\"width\":8.5,\"whole\":11,\"ok\":true,\"none\":null,\"list\":[1,2],\"nan\":null}", json);
    }

    [Fact]
    public void EscapesSoOneObjectIsOneLine()
    {
        var json = Json.Write("a\"b\\c\nd\re\tf\u0001g\u2028h");
        Assert.Equal("\"a\\\"b\\\\c\\nd\\re\\tf\\u0001g\\u2028h\"", json);
        Assert.DoesNotContain("\n", json);
    }

    [Fact]
    public void WritesWindowsPathsAndNonAsciiNames()
    {
        Assert.Equal("\"C:\\\\Temp\\\\page-0001.png\"", Json.Write(@"C:\Temp\page-0001.png"));
        Assert.Equal("\"Canon CanoScan LiDE 400 – Büro\"", Json.Write("Canon CanoScan LiDE 400 – Büro"));
    }

    [Fact]
    public void ParsesObjectsArraysAndEscapes()
    {
        var parsed = (Dictionary<string, object?>)Json.Parse(" {\"a\": [1, -2.5e1, true, null], \"b\": \"x\\u00e9\\n\", \"c\": {}} ")!;
        var a = (List<object?>)parsed["a"]!;
        Assert.Equal(new object?[] { 1.0, -25.0, true, null }, a);
        Assert.Equal("x\u00e9\n", parsed["b"]);
        Assert.Empty((Dictionary<string, object?>)parsed["c"]!);
    }

    [Theory]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("{\"a\" 1}")]
    [InlineData("[1,]")]
    [InlineData("{} x")]
    [InlineData("tru")]
    [InlineData("\"unterminated")]
    public void RejectsBadJson(string text)
    {
        Assert.Throws<FormatException>(() => Json.Parse(text));
    }

    [Fact]
    public void RejectsDeepNesting()
    {
        Assert.Throws<FormatException>(() => Json.Parse(new string('[', 100) + new string(']', 100)));
    }
}

public class OutputTests
{
    [Fact]
    public void OneFlushedLinePerMessage()
    {
        var stream = new MemoryStream();
        var output = new Output(stream);
        output.Error(ErrorCodes.Busy, "Busy");
        output.Status("Warming up");
        var text = Encoding.UTF8.GetString(stream.ToArray());
        Assert.Equal(
            "{\"type\":\"error\",\"code\":\"busy\",\"message\":\"Busy\"}\n{\"type\":\"status\",\"message\":\"Warming up\"}\n",
            text);
    }

    [Fact]
    public void ClosedStdoutMeansStop()
    {
        var stream = new MemoryStream();
        stream.Dispose();
        var output = new Output(stream);
        var broken = 0;
        output.Broken += () => broken++;
        output.Status("one");
        output.Status("two");
        Assert.Equal(1, broken);
        Assert.True(output.IsBroken);
    }
}

public class CommandLineTests
{
    [Fact]
    public void ParsesCommandAndNamedValues()
    {
        var cl = CommandLine.Parse(new[] { "SCAN", "-Id", "wia:{x}\\0001", "-OUTDIR", @"C:\t", "-Options", "e30=" });
        Assert.Equal("scan", cl.Command);
        Assert.Equal("wia:{x}\\0001", cl.Require("id"));
        Assert.Equal(@"C:\t", cl.Require("outdir"));
        Assert.Equal("e30=", cl.Get("options"));
        Assert.Null(cl.Get("window"));
    }

    [Fact]
    public void AcceptsTheOlderDeviceIdName()
    {
        Assert.Equal("twain:X", CommandLine.Parse(new[] { "caps", "-DeviceId", "twain:X" }).Require("id"));
    }

    [Theory]
    [InlineData(new string[0], "No command")]
    [InlineData(new[] { "caps", "-Id" }, "-Id needs a value")]
    [InlineData(new[] { "caps", "Id", "x" }, "Unexpected argument")]
    [InlineData(new[] { "caps", "-", "x" }, "Unexpected argument")]
    public void BadArgumentsAreErrors(string[] args, string message)
    {
        var e = Assert.Throws<ScanException>(() => CommandLine.Parse(args));
        Assert.Equal(ErrorCodes.Failed, e.Code);
        Assert.Contains(message, e.Message);
    }

    [Fact]
    public void MissingRequiredValue()
    {
        var e = Assert.Throws<ScanException>(() => CommandLine.Parse(new[] { "scan", "-Id", "x" }).Require("outdir"));
        Assert.Equal("-OutDir is required", e.Message);
    }

    [Fact]
    public void UnknownCommandIsAnError()
    {
        var e = Assert.Throws<ScanException>(() => Program.Run(new[] { "print" }, new Output(new MemoryStream())));
        Assert.Equal(ErrorCodes.Failed, e.Code);
        Assert.Contains("Unknown command", e.Message);
    }

    [Theory]
    [InlineData("wia:{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000", "wia", "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000")]
    [InlineData("twain:EPSON Perfection V39", "twain", "EPSON Perfection V39")]
    public void RoutesIdsToTheirDriver(string id, string prefix, string local)
    {
        var (driver, localId) = Program.Route(id);
        Assert.Equal(prefix, driver.IdPrefix);
        Assert.Equal(local, localId);
    }

    [Theory]
    [InlineData("twain32:Old scanner")]
    [InlineData("escl:printer")]
    [InlineData("wia:")]
    [InlineData("nothing")]
    public void IdsForOtherHelpersAreNoScanner(string id)
    {
        Assert.Equal(ErrorCodes.NoScanner, Assert.Throws<ScanException>(() => Program.Route(id)).Code);
    }

    [Fact]
    public void WindowHandles()
    {
        Assert.Equal(IntPtr.Zero, Program.ParseWindow(null));
        // Not a window: ignored rather than an error
        Assert.Equal(IntPtr.Zero, Program.ParseWindow("0x7FFFFFF0"));
        Assert.Equal(IntPtr.Zero, Program.ParseWindow("12345"));
        Assert.Throws<ScanException>(() => Program.ParseWindow("window"));
    }
}

public class ErrorMapTests
{
    [Theory]
    [InlineData(0x80210002u, "paper-jam")]
    [InlineData(0x80210004u, "paper-jam")]
    [InlineData(0x80210003u, "feeder-empty")]
    [InlineData(0x80210005u, "offline")]
    [InlineData(0x8021000Au, "offline")]
    [InlineData(0x8007001Fu, "offline")]
    [InlineData(0x80210006u, "busy")]
    [InlineData(0x80210007u, "busy")]
    [InlineData(0x8021000Du, "busy")]
    [InlineData(0x80210009u, "no-scanner")]
    [InlineData(0x80210015u, "no-scanner")]
    [InlineData(0x80210010u, "cover-open")]
    [InlineData(0x80210016u, "cover-open")]
    [InlineData(0x80210014u, "double-feed")]
    [InlineData(0x8021000Bu, "unsupported")]
    [InlineData(0x8021000Cu, "unsupported")]
    [InlineData(0x80070057u, "unsupported")]
    [InlineData(0x80070005u, "blocked")]
    [InlineData(0x80070422u, "blocked")]
    [InlineData(0x80210001u, "failed")]
    [InlineData(0x80210011u, "failed")]
    [InlineData(0x8000FFFFu, "failed")]
    public void WiaErrors(uint hr, string code)
    {
        Assert.Equal(code, ErrorMap.FromHResult(hr).Code);
    }

    [Fact]
    public void UnknownWiaErrorsShowTheirCode()
    {
        Assert.Contains("0x8000FFFF", ErrorMap.FromHResult(0x8000FFFF).Message);
    }

    [Theory]
    [InlineData(3, "no-scanner")]
    [InlineData(4, "busy")]
    [InlineData(20, "paper-jam")]
    [InlineData(21, "double-feed")]
    [InlineData(23, "offline")]
    [InlineData(24, "cover-open")]
    [InlineData(29, "feeder-empty")]
    [InlineData(6, "unsupported")]
    [InlineData(13, "unsupported")]
    [InlineData(16, "blocked")]
    [InlineData(5, "failed")]
    [InlineData(1, "failed")]
    public void TwainConditionCodes(int cc, string code)
    {
        Assert.Equal(code, ErrorMap.FromTwain(cc).Code);
    }

    [Fact]
    public void OtherExceptions()
    {
        Assert.Equal("cover-open", ErrorMap.From(new COMException("x", unchecked((int)0x80210010))).Code);
        Assert.Equal("blocked", ErrorMap.From(new UnauthorizedAccessException("no")).Code);
        Assert.Equal("offline", ErrorMap.From(new TimeoutException()).Code);
        Assert.Equal("failed", ErrorMap.From(new InvalidOperationException("odd")).Code);
        var original = ErrorMap.Busy();
        Assert.Same(original, ErrorMap.From(original));
    }

    [Fact]
    public void EveryCodeIsInTheContract()
    {
        var contract = new HashSet<string>
        {
            "no-scanner", "offline", "busy", "paper-jam", "feeder-empty", "double-feed", "cover-open",
            "unsupported", "blocked", "failed",
        };
        for (uint n = 0; n <= 0x30; n++) Assert.Contains(ErrorMap.FromHResult(0x80210000 + n).Code, contract);
        for (var cc = 0; cc <= 40; cc++) Assert.Contains(ErrorMap.FromTwain(cc).Code, contract);
    }
}
