using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Paperwing.Scan;

/// <summary>
/// One preview or scan: where pages go, cancel requests, and the watchdog
/// that ends the helper if the scanner stops responding.
/// </summary>
internal sealed class ScanJob : IDisposable
{
    /// <summary>A page taking longer than this means the scanner is stuck</summary>
    public static readonly TimeSpan DefaultIdleTimeout = TimeSpan.FromSeconds(150);

    private readonly Output _output;
    private readonly string _outDir;
    private readonly Stopwatch _sinceActivity = Stopwatch.StartNew();
    private readonly Thread _watchdog;
    private readonly ManualResetEvent _stop = new(false);
    private readonly object _activityLock = new();
    private TimeSpan _idleTimeout;
    private int _suspended;
    private int _cancelRequested;
    private int _pages;

    public ScanJob(Output output, string outDir, ScanOptions options, bool preview, IntPtr parentWindow, TimeSpan? idleTimeout = null)
    {
        _output = output;
        _outDir = CheckOutDir(outDir);
        Options = options;
        Preview = preview;
        ParentWindow = parentWindow;
        _idleTimeout = idleTimeout ?? DefaultIdleTimeout;
        _watchdog = new Thread(Watch) { IsBackground = true, Name = "Watchdog" };
        _watchdog.Start();
    }

    public ScanOptions Options { get; }
    public bool Preview { get; }
    /// <summary>Paperwing's window, to own the scanner's own windows (nativeUi)</summary>
    public IntPtr ParentWindow { get; }
    public int Pages => _pages;
    public bool CancelRequested => _cancelRequested != 0;
    public string OutDir => _outDir;

    /// <summary>Raised once, on the thread that asked to cancel</summary>
    public event Action? Cancelled;

    public void RequestCancel()
    {
        if (Interlocked.Exchange(ref _cancelRequested, 1) != 0) return;
        try
        {
            Cancelled?.Invoke();
        }
        catch (Exception)
        {
            // Cancelling is best effort; the driver ends the scan as it can
        }
    }

    /// <summary>The scanner did something: it isn't stuck</summary>
    public void Activity()
    {
        lock (_activityLock) _sinceActivity.Restart();
    }

    /// <summary>
    /// While the scanner's own window is open the person may take as long as
    /// they like, so the watchdog waits.
    /// </summary>
    public void SuspendWatchdog() => Interlocked.Increment(ref _suspended);

    public void ResumeWatchdog()
    {
        Activity();
        Interlocked.Decrement(ref _suspended);
    }

    private void Watch()
    {
        while (!_stop.WaitOne(500))
        {
            TimeSpan idle;
            lock (_activityLock) idle = _sinceActivity.Elapsed;
            if (_suspended > 0 || idle < _idleTimeout) continue;
            _output.Error(ErrorCodes.Offline, "The scanner stopped responding.");
            // The driver is stuck inside a call that won't return; ending the
            // process is the one sure way to let go of the scanner.
            Native.Terminate(2);
        }
    }

    /// <summary>The next page's file: always directly inside OutDir</summary>
    private string NextPath(int index)
    {
        var path = Path.Combine(_outDir, "page-" + index.ToString("D4", CultureInfo.InvariantCulture) + ".png");
        return Path.GetDirectoryName(Path.GetFullPath(path)) == _outDir
            ? path
            : throw new ScanException(ErrorCodes.Failed, "Page path escaped the output folder");
    }

    /// <summary>Saves a page as PNG and reports it</summary>
    public void AddPage(Image image, int dpi, string side)
    {
        Activity();
        // (pages arrive one at a time, from the driver's thread)
        var index = _pages + 1;
        var path = NextPath(index);
        var resolution = dpi > 0 ? dpi : Imaging.ResolutionOf(image);
        Imaging.SavePng(image, path, resolution, Options.Invert);
        _output.Emit(new Dictionary<string, object?>
        {
            ["type"] = "page",
            ["file"] = path,
            ["dpi"] = resolution,
            ["width"] = image.Width,
            ["height"] = image.Height,
            ["side"] = side,
        });
        _pages = index;
        Activity();
    }

    /// <summary>A page delivered as an image file's bytes (BMP, PNG, TIFF, JPEG)</summary>
    public void AddPage(Stream data, int dpi, string side)
    {
        using var memory = Imaging.ToMemory(data);
        if (memory.Length == 0) return;
        Image image;
        try
        {
            image = Image.FromStream(memory, false, false);
        }
        catch (ArgumentException e)
        {
            // Half an image: the connection dropped mid-page
            throw new ScanException(ErrorCodes.Offline, "The scanner sent an incomplete page.", e);
        }
        using (image) AddPage(image, dpi > 0 ? dpi : Imaging.ResolutionOf(image), side);
    }

    /// <summary>Every page of an image file (a multi-page TIFF from the scanner's own window)</summary>
    public void AddPagesFromFile(string file)
    {
        using var image = Image.FromFile(file);
        var frames = 1;
        try
        {
            frames = image.GetFrameCount(FrameDimension.Page);
        }
        catch (Exception)
        {
            // Not a multi-page format
        }
        for (var i = 0; i < frames; i++)
        {
            if (frames > 1) image.SelectActiveFrame(FrameDimension.Page, i);
            AddPage(image, Imaging.ResolutionOf(image), "front");
        }
    }

    /// <summary>A folder inside OutDir for drivers that insist on writing files themselves</summary>
    public string DriverFolder()
    {
        var dir = Path.Combine(_outDir, "driver-files");
        Directory.CreateDirectory(dir);
        return dir;
    }

    public void Status(string message)
    {
        Activity();
        _output.Status(message);
    }

    public void Dispose()
    {
        _stop.Set();
        var driverDir = Path.Combine(_outDir, "driver-files");
        try
        {
            if (Directory.Exists(driverDir)) Directory.Delete(driverDir, true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>OutDir must be an existing folder; pages are written only there</summary>
    public static string CheckOutDir(string outDir)
    {
        if (string.IsNullOrWhiteSpace(outDir)) throw new ScanException(ErrorCodes.Failed, "-OutDir is required");
        string full;
        try
        {
            full = Path.GetFullPath(outDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new ScanException(ErrorCodes.Failed, "-OutDir isn't a valid folder: " + e.Message);
        }
        if (!Directory.Exists(full)) throw new ScanException(ErrorCodes.Failed, "-OutDir doesn't exist: " + outDir);
        return full;
    }
}

internal static class Native
{
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumThreadWindows(uint threadId, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong32(IntPtr hWnd, int index, int value);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const uint WM_CLOSE = 0x0010;
    private const int GWLP_HWNDPARENT = -8;

    /// <summary>Ends this process at once (after a final message has been flushed)</summary>
    public static void Terminate(uint exitCode)
    {
        TerminateProcess(GetCurrentProcess(), exitCode);
    }

    /// <summary>Makes a window owned by another (Paperwing's), so it stays in front of it</summary>
    public static void SetOwner(IntPtr window, IntPtr owner)
    {
        if (window == IntPtr.Zero || owner == IntPtr.Zero || !IsWindow(owner)) return;
        if (IntPtr.Size == 8) SetWindowLongPtr64(window, GWLP_HWNDPARENT, owner);
        else SetWindowLong32(window, GWLP_HWNDPARENT, owner.ToInt32());
    }

    /// <summary>Closes the windows a thread has open (the scanner's dialog, on cancel)</summary>
    public static void CloseThreadWindows(uint threadId)
    {
        EnumThreadWindows(threadId, (hWnd, _) =>
        {
            if (IsWindowVisible(hWnd)) PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
    }
}
