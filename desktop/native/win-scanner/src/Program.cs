using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;

namespace Paperwing.Scan;

/// <summary>
/// paperwing-scan.exe (x64: WIA and 64-bit TWAIN) and paperwing-twain32.exe
/// (x86: 32-bit TWAIN), Paperwing's scanner helpers for Windows. One process
/// per command; JSON lines on stdout (the contract with desktop/scan.cjs):
///
///   list
///   caps    -Id &lt;id&gt;
///   preview -Id &lt;id&gt; -OutDir &lt;folder&gt; [-Options &lt;base64 JSON&gt;] [-Window &lt;hwnd&gt;]
///   scan    -Id &lt;id&gt; -OutDir &lt;folder&gt; [-Options &lt;base64 JSON&gt;] [-Window &lt;hwnd&gt;]
///
/// "cancel" on stdin stops a scan after the current page. Exit code 0, or 2
/// after an error line.
/// </summary>
internal static class Program
{
    /// <summary>Listing reports what it found by then</summary>
    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan CapsTimeout = TimeSpan.FromSeconds(45);

    private static int Main(string[] args)
    {
        var output = new Output(Console.OpenStandardOutput());
        int code;
        try
        {
            code = Run(args, output);
        }
        catch (Exception e)
        {
            var error = ErrorMap.From(e);
            output.Error(error.Code, error.Message);
            code = 2;
        }
        // Scanner drivers live in this process; some hang while unloading.
        // Everything is released and the output flushed by now, so end here.
        Native.Terminate((uint)code);
        return code;
    }

    internal static int Run(string[] args, Output output)
    {
        var cl = CommandLine.Parse(args);
        switch (cl.Command)
        {
            case "list":
                List(output);
                return 0;
            case "caps":
                Caps(output, cl.Require("id"));
                return 0;
            case "preview":
            case "scan":
                return Scan(output, cl, cl.Command == "preview");
            default:
                throw new ScanException(ErrorCodes.Failed,
                    $"Unknown command \"{cl.Command}\". Use list, caps, preview or scan.");
        }
    }

    private static IEnumerable<IScanDriver> Drivers()
    {
#if TWAIN32
        yield return new Twain.TwainDriver();
#else
        yield return new Wia.WiaDriver();
        yield return new Twain.TwainDriver();
#endif
    }

    /// <summary>The driver an id belongs to ("wia:…", "twain:…", "twain32:…")</summary>
    internal static (IScanDriver Driver, string LocalId) Route(string id)
    {
        foreach (var driver in Drivers())
        {
            var prefix = driver.IdPrefix + ":";
            if (id.StartsWith(prefix, StringComparison.Ordinal) && id.Length > prefix.Length)
                return (driver, id.Substring(prefix.Length));
        }
        throw ErrorMap.NoScanner();
    }

    private static void List(Output output)
    {
        // The drivers list in parallel; a driver that hangs doesn't hold the others up
        var drivers = Drivers().ToList();
        var results = new List<ScannerInfo>?[drivers.Count];
        var threads = drivers.Select((driver, i) =>
        {
            var t = new Thread(() =>
            {
                try
                {
                    results[i] = driver.List();
                }
                catch (Exception)
                {
                    // A driver family that isn't there (no WIA service, no
                    // TWAIN manager) just has no scanners
                    results[i] = new List<ScannerInfo>();
                }
            })
            { IsBackground = true, Name = "List " + driver.IdPrefix };
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            return t;
        }).ToList();
        var deadline = DateTime.UtcNow + ListTimeout;
        foreach (var t in threads) t.Join(Max(TimeSpan.Zero, deadline - DateTime.UtcNow));
        var scanners = results.Where(r => r != null).SelectMany(r => r!).ToList();
        DeviceKey.Assign(scanners);
        output.Emit(new Dictionary<string, object?>
        {
            ["type"] = "scanners",
            ["scanners"] = scanners.Select(s => s.ToJson()).ToList(),
        });
    }

    private static void Caps(Output output, string id)
    {
        var (driver, local) = Route(id);
        Dictionary<string, object?>? caps = null;
        Exception? error = null;
        var t = new Thread(() =>
        {
            try
            {
                caps = driver.Caps(local);
            }
            catch (Exception e)
            {
                error = e;
            }
        })
        { IsBackground = true, Name = "Caps" };
        t.Start();
        if (!t.Join(CapsTimeout))
            throw new ScanException(ErrorCodes.Offline, "The scanner didn't respond.");
        if (error != null) throw ErrorMap.From(error);
        output.Emit(caps!);
    }

    private static int Scan(Output output, CommandLine cl, bool preview)
    {
        var id = cl.Require("id");
        var outDir = cl.Require("outdir");
        var options = ScanOptions.Parse(cl.Get("options"));
        var window = ParseWindow(cl.Get("window"));
        var (driver, local) = Route(id);
        using var job = new ScanJob(output, outDir, options, preview, window);
        output.Broken += job.RequestCancel;
        StartCancelReader(job);
        try
        {
            driver.Scan(local, job);
        }
        catch (Exception) when (job.CancelRequested)
        {
            // Stopping can make a driver report an error: it was asked to stop
        }
        var done = new Dictionary<string, object?> { ["type"] = "done", ["pages"] = job.Pages };
        if (job.CancelRequested) done["cancelled"] = true;
        output.Emit(done);
        return 0;
    }

    /// <summary>"cancel" on stdin stops the scan after the current page</summary>
    private static void StartCancelReader(ScanJob job)
    {
        var t = new Thread(() =>
        {
            try
            {
                string? line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Trim().Equals("cancel", StringComparison.OrdinalIgnoreCase))
                    {
                        job.RequestCancel();
                        return;
                    }
                }
                // End of input isn't a cancel: Paperwing may not keep stdin open
            }
            catch (IOException)
            {
            }
        })
        { IsBackground = true, Name = "Cancel reader" };
        t.Start();
    }

    internal static IntPtr ParseWindow(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return IntPtr.Zero;
        var s = value!.Trim();
        long handle;
        var ok = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? long.TryParse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out handle)
            : long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out handle);
        if (!ok) throw new ScanException(ErrorCodes.Failed, "-Window must be a window handle");
        var hwnd = new IntPtr(handle);
        return Native.IsWindow(hwnd) ? hwnd : IntPtr.Zero;
    }

    private static TimeSpan Max(TimeSpan a, TimeSpan b) => a > b ? a : b;
}

/// <summary>A command, then -Name value pairs (names case-insensitive)</summary>
internal sealed class CommandLine
{
    private readonly Dictionary<string, string> _named = new(StringComparer.Ordinal);

    private CommandLine(string command)
    {
        Command = command;
    }

    public string Command { get; }

    public static CommandLine Parse(string[] args)
    {
        if (args.Length == 0) throw new ScanException(ErrorCodes.Failed, "No command. Use list, caps, preview or scan.");
        var cl = new CommandLine(args[0].ToLowerInvariant());
        for (var i = 1; i < args.Length; i++)
        {
            var name = args[i];
            if (!name.StartsWith("-", StringComparison.Ordinal) || name.TrimStart('-').Length == 0)
                throw new ScanException(ErrorCodes.Failed, $"Unexpected argument \"{name}\"");
            if (i + 1 >= args.Length) throw new ScanException(ErrorCodes.Failed, $"{name} needs a value");
            var key = name.TrimStart('-').ToLowerInvariant();
            // -DeviceId: what the earlier helpers (wia.ps1, the macOS helper) take
            if (key == "deviceid") key = "id";
            cl._named[key] = args[++i];
        }
        return cl;
    }

    public string? Get(string name) => _named.TryGetValue(name, out var v) ? v : null;

    public string Require(string name)
    {
        var v = Get(name);
        if (string.IsNullOrWhiteSpace(v)) throw new ScanException(ErrorCodes.Failed, $"-{CapitalName(name)} is required");
        return v!;
    }

    private static string CapitalName(string name) => name switch
    {
        "id" => "Id",
        "outdir" => "OutDir",
        _ => name,
    };
}

/// <summary>One driver family: WIA, or TWAIN (64- or 32-bit, by the process)</summary>
internal interface IScanDriver
{
    /// <summary>"wia", "twain" (64-bit) or "twain32"</summary>
    string IdPrefix { get; }

    List<ScannerInfo> List();

    /// <summary>The whole caps message</summary>
    Dictionary<string, object?> Caps(string localId);

    /// <summary>Scans (or previews) into the job; returns when the scanner is released</summary>
    void Scan(string localId, ScanJob job);
}
