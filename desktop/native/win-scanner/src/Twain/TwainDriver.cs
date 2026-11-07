using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NTwain;
using NTwain.Data;

namespace Paperwing.Scan.Twain;

/// <summary>
/// TWAIN through NAPS2.NTwain. paperwing-scan.exe reaches 64-bit drivers;
/// paperwing-twain32.exe the 32-bit ones (most office document scanners'
/// TWAIN drivers are 32-bit only). Approaches from NAPS2
/// (NAPS2.Sdk/Scan/Internal/Twain): calls on an STA thread with a message
/// loop; the modern TWAIN manager (twaindsm.dll) with the old twain_32.dll as
/// the 32-bit fallback; memory transfer by default (native for Kyocera
/// Ecosys); "WIA-" sources hidden (Windows' TWAIN view of WIA scanners,
/// which are listed through WIA already); cancel at the next page.
/// </summary>
internal sealed class TwainDriver : IScanDriver
{
#if TWAIN32
    public string IdPrefix => "twain32";
    private const string Api = "twain32";
#else
    public string IdPrefix => "twain";
    private const string Api = "twain64";
#endif

    internal static readonly TWIdentity AppId = TWIdentity.Create(
        DataGroups.Image | DataGroups.Control, new Version(1, 3, 0), "Paperwing", "Paperwing", "Paperwing",
        "Paperwing scanning");

    static TwainDriver()
    {
        // NTwain writes a trace of every call to the debugger output otherwise
        PlatformInfo.Current.Log.IsDebugEnabled = false;
    }

    /// <summary>
    /// The TWAIN managers to try, in order: the modern twaindsm.dll (64-bit
    /// drivers need it), then, in the 32-bit helper only, Windows' old
    /// twain_32.dll, as NAPS2 does (Citrix only passes TWAIN through that one).
    /// </summary>
    internal static IEnumerable<bool> Managers()
    {
        yield return true;
        if (!Environment.Is64BitProcess) yield return false;
    }

    /// <summary>Selects a TWAIN manager; false if it isn't installed</summary>
    internal static bool UseManager(bool modern)
    {
        PlatformInfo.Current.PreferNewDSM = modern;
        return PlatformInfo.Current.DsmExists && PlatformInfo.Current.UseNewWinDSM == modern;
    }

    public List<ScannerInfo> List()
    {
        using var host = new TwainHost(IntPtr.Zero);
        return host.Invoke(() =>
        {
            var result = new List<ScannerInfo>();
            foreach (var modern in Managers())
            {
                if (!UseManager(modern)) continue;
                var session = new TwainSession(AppId);
                if (session.Open(host.CreateHook()) != ReturnCode.Success) continue;
                try
                {
                    foreach (var ds in session.GetSources())
                    {
                        var name = ds.Name ?? "";
                        if (name.Length == 0 || name.StartsWith("WIA-", StringComparison.Ordinal)) continue;
                        if (result.Any(r => r.Name == name)) continue;
                        result.Add(new ScannerInfo(IdPrefix + ":" + name, name, "twain", Api, ds.Manufacturer ?? "", name, "unknown"));
                    }
                }
                finally
                {
                    session.Close();
                }
                // The old manager is only a fallback for when the modern one finds nothing
                if (result.Count > 0) break;
            }
            return result;
        });
    }

    public Dictionary<string, object?> Caps(string localId)
    {
        using var host = new TwainHost(IntPtr.Zero);
        return host.Invoke(() =>
        {
            var (session, source) = OpenSource(host, localId, null);
            try
            {
                var sources = ReadSources(source);
                return new Dictionary<string, object?>
                {
                    ["type"] = "caps",
                    ["driver"] = "twain",
                    ["api"] = Api,
                    ["nativeUi"] = true,
                    ["sources"] = sources.Select(s => s.ToJson()).ToList(),
                };
            }
            finally
            {
                Close(session, source);
            }
        });
    }

    public void Scan(string localId, ScanJob job)
    {
        using var host = new TwainHost(job.ParentWindow);
        new TwainScan(host, job, localId).Run();
    }

    /// <summary>Opens the session and the driver, trying each TWAIN manager</summary>
    internal static (TwainSession Session, DataSource Source) OpenSource(TwainHost host, string name, Action<TwainSession>? hook)
    {
        foreach (var modern in Managers())
        {
            if (!UseManager(modern)) continue;
            var session = new TwainSession(AppId);
            hook?.Invoke(session);
            if (session.Open(host.CreateHook()) != ReturnCode.Success) continue;
            var source = session.GetSources().FirstOrDefault(s => s.Name == name);
            if (source == null)
            {
                session.Close();
                continue;
            }
            if (source.Open() != ReturnCode.Success)
            {
                var status = session.GetStatus();
                session.Close();
                throw ErrorMap.FromTwain((int)status.ConditionCode);
            }
            return (session, source);
        }
        throw ErrorMap.NoScanner();
    }

    internal static void Close(TwainSession session, DataSource? source)
    {
        try
        {
            if (session.State > 4) session.ForceStepDown(2);
            if (session.State == 4) source?.Close();
            if (session.State >= 3) session.Close();
        }
        catch (Exception)
        {
            // Closing is best effort; the process ends right after
        }
    }

    /// <summary>Which sources the driver has: flatbed, feeder or both</summary>
    internal static (bool Flatbed, bool Feeder) Sources(DataSource ds)
    {
        var c = ds.Capabilities;
        if (TwainCaps.Supported(c.CapFeederEnabled))
        {
            // As NAPS2: a source exists if the driver accepts choosing it
            var flatbed = TwainCaps.Set(c.CapFeederEnabled, BoolType.False) && TwainCaps.Current(c.CapFeederEnabled) == BoolType.False;
            var feeder = TwainCaps.Set(c.CapFeederEnabled, BoolType.True) && TwainCaps.Current(c.CapFeederEnabled) == BoolType.True;
            if (flatbed || feeder) return (flatbed, feeder);
        }
        // No feeder switch: a sheet-fed scanner reports paper in its feeder
        var sheetFed = TwainCaps.Supported(c.CapFeederLoaded) || TwainCaps.Supported(c.CapAutoFeed);
        return (!sheetFed, sheetFed);
    }

    private static List<SourceCaps> ReadSources(DataSource ds)
    {
        var c = ds.Capabilities;
        TwainCaps.Set(c.ICapUnits, Unit.Inches);
        var (flatbed, feeder) = Sources(ds);
        var switchable = TwainCaps.Supported(c.CapFeederEnabled);
        var result = new List<SourceCaps>();
        if (flatbed)
        {
            if (switchable) TwainCaps.Set(c.CapFeederEnabled, BoolType.False);
            result.Add(SourceCaps(ds, "flatbed"));
        }
        if (feeder)
        {
            if (switchable) TwainCaps.Set(c.CapFeederEnabled, BoolType.True);
            result.Add(SourceCaps(ds, "feeder"));
        }
        return result;
    }

    private static SourceCaps SourceCaps(DataSource ds, string id)
    {
        var c = ds.Capabilities;
        var feeder = id == "feeder";
        var caps = new SourceCaps { Id = id, CanPreview = !feeder };

        var x = TwainCaps.Read(c.ICapXResolution);
        if (x.Range != null)
            caps.ResolutionRange = x.Range;
        else if (x.List != null)
        {
            var list = x.List.Select(v => (int)Math.Round(v)).Where(v => v > 0).ToList();
            var y = TwainCaps.Read(c.ICapYResolution).List?.Select(v => (int)Math.Round(v)).ToList();
            if (y != null && y.Count > 0)
            {
                var both = list.Intersect(y).ToList();
                if (both.Count > 0) list = both;
            }
            caps.Resolutions = list;
        }

        var pixelTypes = (TwainCaps.Read(c.ICapPixelType).List ?? new List<double>()).Select(v => (PixelType)(int)v).ToList();
        if (pixelTypes.Contains(PixelType.RGB)) caps.Colors.Add("color");
        if (pixelTypes.Contains(PixelType.Gray)) caps.Colors.Add("gray");
        if (pixelTypes.Contains(PixelType.BlackWhite)) caps.Colors.Add("bw");
        if (caps.Colors.Count == 0) caps.Colors.AddRange(new[] { "color", "gray", "bw" });

        caps.MaxWidth = TwainCaps.Current(c.ICapPhysicalWidth) is TWFix32 w ? TwainCaps.Fix(w) : 0;
        caps.MaxHeight = TwainCaps.Current(c.ICapPhysicalHeight) is TWFix32 h ? TwainCaps.Fix(h) : 0;
        caps.MinWidth = TwainCaps.Current(c.ICapMinimumWidth) is TWFix32 mw ? TwainCaps.Fix(mw) : 0;
        caps.MinHeight = TwainCaps.Current(c.ICapMinimumHeight) is TWFix32 mh ? TwainCaps.Fix(mh) : 0;
        // Feeders that take paper of any length report a huge height
        if (caps.MaxHeight > 1000) caps.MaxHeight = 0;

        if (feeder)
        {
            caps.Duplex = TwainCaps.Supported(c.CapDuplex)
                ? TwainCaps.Current(c.CapDuplex) is Duplex d && d != Duplex.None
                : TwainCaps.Settable(c.CapDuplexEnabled);
            caps.BlankPageSkip = TwainCaps.Settable(c.ICapAutoDiscardBlankPages);
            caps.DoubleFeed = TwainCaps.Supported(c.CapDoubleFeedDetection);
            if (TwainCaps.Supported(c.CapFeederLoaded))
                caps.FeederLoaded = TwainCaps.Current(c.CapFeederLoaded) == BoolType.True;
        }

        var sizes = TwainCaps.Read(c.ICapSupportedSizes).List;
        if (sizes != null && sizes.Count > 0)
            caps.PaperSizes = PaperSizes.FromTwain(sizes.Select(v => (int)v), caps.MaxWidth, caps.MaxHeight);
        if (caps.PaperSizes.Count == 0) caps.PaperSizes = PaperSizes.CommonFitting(caps.MaxWidth, caps.MaxHeight);

        var autoSizes = TwainCaps.Read(c.ICapAutoSize).List;
        caps.AutoSize = autoSizes != null && autoSizes.Contains((int)AutoSize.Auto);
        caps.AutoDeskew = TwainCaps.Settable(c.ICapAutomaticDeskew);
        caps.AutoCrop = TwainCaps.Settable(c.ICapAutomaticBorderDetection);
        // Black and white pages come with a palette: the helper inverts them
        caps.Invert = caps.Colors.Contains("bw");
        caps.Brightness = TwainCaps.RangeOf(c.ICapBrightness);
        caps.Contrast = TwainCaps.RangeOf(c.ICapContrast);
        caps.Threshold = caps.Colors.Contains("bw") ? TwainCaps.RangeOf(c.ICapThreshold) : null;
        return caps;
    }

    /// <summary>NAPS2: Kyocera Ecosys drivers only work with native transfers</summary>
    internal static bool PrefersNative(DataSource ds)
    {
        static bool Has(string? s, string word) => s != null && s.IndexOf(word, StringComparison.OrdinalIgnoreCase) >= 0;
        return Has(ds.Manufacturer, "Kyocera") && (Has(ds.ProductFamily, "Ecosys") || Has(ds.Name, "Ecosys"));
    }
}

/// <summary>
/// One TWAIN scan, run on the TWAIN thread. The TWAIN states (TWAIN 2.4
/// specification, chapter 2): 3 manager open, 4 driver open, 5 enabled
/// (scanning, or its window open), 6 page ready, 7 transferring.
/// </summary>
internal sealed class TwainScan
{
    /// <summary>After a cancel, how long to wait for the scanner to reach a page boundary</summary>
    private static readonly TimeSpan CancelGrace = TimeSpan.FromSeconds(5);

    private readonly TwainHost _host;
    private readonly ScanJob _job;
    private readonly string _name;
    private readonly TaskCompletionSource<bool> _done = new();
    private TwainSession? _session;
    private DataSource? _source;
    private ScanOptions _options;
    private Exception? _error;
    private bool _finished;
    private bool _memory;
    private bool _extInfo;
    private bool _duplex;
    private bool _feeder;
    private bool _whiteIsZero;
    private bool _uiOpen;
    private int _dpi;
    private int _pages;
    private StripImage? _strip;
    private int _stripDpi;
    private Timer? _cancelTimer;

    public TwainScan(TwainHost host, ScanJob job, string name)
    {
        _host = host;
        _job = job;
        _name = name;
        _options = job.Options;
    }

    public void Run()
    {
        _job.Cancelled += () => _host.BeginInvoke(OnCancel);
        _host.BeginInvoke(Start);
        _done.Task.Wait();
        _cancelTimer?.Dispose();
        if (_error != null) throw ErrorMap.From(_error);
        // The driver's window closed without scanning
        if (_options.NativeUi && !_job.Preview && _pages == 0) _job.RequestCancel();
        if (_pages == 0 && _feeder && !_job.CancelRequested && !_options.NativeUi) throw ErrorMap.FeederEmpty();
    }

    private void Start()
    {
        try
        {
            (_session, _source) = TwainDriver.OpenSource(_host, _name, s =>
            {
                s.TransferReady += OnTransferReady;
                s.DataTransferred += OnDataTransferred;
                s.TransferCanceled += (_, _) => _strip = null;
                s.TransferError += OnTransferError;
                // (closing from inside NTwain's own handler would cut its state changes short)
                s.SourceDisabled += (_, _) => _host.BeginInvoke(() => Finish(null));
            });
            if (_job.CancelRequested)
            {
                Finish(null);
                return;
            }
            Configure();
            var nativeUi = _options.NativeUi && !_job.Preview;
            if (nativeUi)
            {
                // The person sets up the scan in the driver's window: no time limit until it starts
                _uiOpen = true;
                _job.SuspendWatchdog();
            }
            var rc = _source.Enable(nativeUi ? SourceEnableMode.ShowUI : SourceEnableMode.NoUI, false, _host.Handle);
            if (rc != ReturnCode.Success) throw ErrorMap.FromTwain((int)_source.GetStatus().ConditionCode);
            _job.Activity();
        }
        catch (Exception e)
        {
            Finish(e);
        }
    }

    private void Configure()
    {
        var ds = _source!;
        var c = ds.Capabilities;
        var transfer = _options.Transfer ?? (TwainDriver.PrefersNative(ds) ? "native" : "memory");
        _memory = transfer == "memory" && TwainCaps.Set(c.ICapXferMech, XferMech.Memory);
        if (!_memory) TwainCaps.Set(c.ICapXferMech, XferMech.Native);
        else TwainCaps.Set(c.ICapCompression, CompressionType.None);
        // Which side each page is (duplex), where the driver can say
        _extInfo = TwainCaps.Set(c.ICapExtImageInfo, BoolType.True);

        var (hasFlatbed, hasFeeder) = TwainDriver.Sources(ds);
        if (_options.Source == null) _options = _options.WithSource(hasFlatbed ? "flatbed" : "feeder");
        if (_job.Preview)
        {
            if (!hasFlatbed) throw ErrorMap.Unsupported("previews (it has no flatbed)");
            _options = _options.WithSource("flatbed");
        }

        if (_options.NativeUi && !_job.Preview)
        {
            // The driver's window decides everything else
            _feeder = false;
            _duplex = TwainCaps.Current(c.CapDuplexEnabled) == BoolType.True;
            _whiteIsZero = TwainCaps.Current(c.ICapPixelFlavor) == PixelFlavor.Vanilla;
            return;
        }

        TwainCaps.Set(c.CapIndicators, BoolType.False);
        TwainCaps.Set(c.ICapUnits, Unit.Inches);

        _feeder = _options.Feeder;
        var switchable = TwainCaps.Supported(c.CapFeederEnabled);
        if (_feeder)
        {
            if (!hasFeeder) throw ErrorMap.Unsupported("a document feeder");
            if (switchable && !TwainCaps.Set(c.CapFeederEnabled, BoolType.True)) throw ErrorMap.Unsupported("a document feeder");
            TwainCaps.Set(c.CapAutoFeed, BoolType.True);
            if (_options.Duplex)
            {
                if (!TwainCaps.Set(c.CapDuplexEnabled, BoolType.True)) throw ErrorMap.Unsupported("two-sided scanning");
                _duplex = true;
            }
            else
                TwainCaps.Set(c.CapDuplexEnabled, BoolType.False);
        }
        else
        {
            if (!hasFlatbed) throw ErrorMap.Unsupported("a flatbed");
            if (switchable) TwainCaps.Set(c.CapFeederEnabled, BoolType.False);
            TwainCaps.Set(c.CapDuplexEnabled, BoolType.False);
            // One page from the glass (OnTransferReady stops after it too)
            TwainCaps.Set(c.CapXferCount, 1);
        }

        if (_job.Preview)
        {
            var res = TwainCaps.Read(c.ICapXResolution);
            _options = _options.ForPreview(_options.Dpi ?? Geometry.PreviewDpi(res.List?.Select(v => (int)Math.Round(v)), res.Range));
            TwainCaps.Set(c.CapXferCount, 1);
        }

        switch (_options.Color)
        {
            case "color":
                TwainCaps.Set(c.ICapPixelType, PixelType.RGB);
                TwainCaps.Set(c.ICapBitDepth, 24);
                break;
            case "gray":
                TwainCaps.Set(c.ICapPixelType, PixelType.Gray);
                TwainCaps.Set(c.ICapBitDepth, 8);
                break;
            case "bw":
                TwainCaps.Set(c.ICapPixelType, PixelType.BlackWhite);
                TwainCaps.Set(c.ICapBitDepth, 1);
                break;
        }

        if (_options.Dpi is int dpi)
        {
            _dpi = TwainCaps.SetClosest(c.ICapXResolution, dpi);
            TwainCaps.SetClosest(c.ICapYResolution, _dpi > 0 ? _dpi : dpi);
        }
        if (_dpi <= 0) _dpi = TwainCaps.Current(c.ICapXResolution) is TWFix32 cur ? (int)Math.Round(TwainCaps.Fix(cur)) : 0;

        ConfigureArea(ds);

        TwainCaps.SetInRange(c.ICapBrightness, _options.Brightness);
        TwainCaps.SetInRange(c.ICapContrast, _options.Contrast);
        if (_options.Color == "bw") TwainCaps.SetInRange(c.ICapThreshold, _options.Threshold);

        if (_options.AutoDeskew is bool deskew) TwainCaps.Set(c.ICapAutomaticDeskew, deskew ? BoolType.True : BoolType.False);
        if (_feeder && _options.BlankPageSkip is bool blank)
            TwainCaps.Set(c.ICapAutoDiscardBlankPages, blank ? BlankPage.Auto : BlankPage.Disable);
        if (_feeder && _options.DoubleFeedStop == true && TwainCaps.Supported(c.CapDoubleFeedDetection))
        {
            var method = TwainCaps.Read(c.CapDoubleFeedDetection).List?.FirstOrDefault() ?? 0;
            TwainCaps.Set(c.CapDoubleFeedDetection, (DoubleFeedDetection)(int)method);
            TwainCaps.Set(c.CapDoubleFeedDetectionResponse, DoubleFeedDetectionResponse.Stop);
        }
        _whiteIsZero = TwainCaps.Current(c.ICapPixelFlavor) == PixelFlavor.Vanilla;
    }

    private void ConfigureArea(DataSource ds)
    {
        var c = ds.Capabilities;
        if (_options.AutoArea)
        {
            var auto = TwainCaps.Set(c.ICapAutoSize, AutoSize.Auto);
            if (!auto && TwainCaps.Supported(c.ICapAutomaticBorderDetection))
            {
                TwainCaps.Set(c.ICapUndefinedImageSize, BoolType.True);
                TwainCaps.Set(c.ICapAutomaticBorderDetection, BoolType.True);
            }
            return;
        }
        if (TwainCaps.Supported(c.ICapAutoSize)) TwainCaps.Set(c.ICapAutoSize, AutoSize.None);
        if (TwainCaps.Supported(c.ICapAutomaticBorderDetection)) TwainCaps.Set(c.ICapAutomaticBorderDetection, BoolType.False);
        // No area asked for: the scanner's default, except a preview covers everything
        if (_options.Area == null && _options.Paper == null && !_job.Preview) return;
        var maxW = TwainCaps.Current(c.ICapPhysicalWidth) is TWFix32 w ? TwainCaps.Fix(w) : 0;
        var maxH = TwainCaps.Current(c.ICapPhysicalHeight) is TWFix32 h ? TwainCaps.Fix(h) : 0;
        if (maxH > 1000) maxH = 0;
        var across = Align.Start;
        if (_feeder)
        {
            across = TwainCaps.Current(c.CapFeederAlignment) switch
            {
                FeederAlignment.Center => Align.Center,
                FeederAlignment.Right => Align.End,
                _ => Align.Start,
            };
        }
        var area = Geometry.ResolveArea(_options, maxW, maxH, across, Align.Start);
        if (ds.DGImage.ImageLayout.Get(out TWImageLayout layout) != ReturnCode.Success) layout = new TWImageLayout();
        layout.Frame = new TWFrame
        {
            Left = (float)area.X,
            Top = (float)area.Y,
            Right = (float)(area.X + area.Width),
            Bottom = (float)(area.Y + area.Height),
        };
        ds.DGImage.ImageLayout.Set(layout);
    }

    private void OnTransferReady(object? sender, TransferReadyEventArgs e)
    {
        _job.Activity();
        if (_uiOpen)
        {
            _uiOpen = false;
            _job.ResumeWatchdog();
        }
        FlushStrip(null);
        // Stop at a page boundary: cancelled, a preview or a flatbed page done
        // (a driver may say more are coming from the glass: the TWAIN sample
        // does with CAP_XFERCOUNT set, and the scan never ended), or a page
        // that failed. (The scanner's own window may send several photos.)
        var onePage = _job.Preview || (!_feeder && !_options.NativeUi);
        if (_job.CancelRequested || _error != null || (onePage && _pages > 0))
        {
            e.CancelAll = true;
            return;
        }
        if (!_memory) return;
        try
        {
            var info = e.PendingImageInfo;
            if (info != null) StartStrip(info);
        }
        catch (Exception ex)
        {
            _error = ex;
            e.CancelAll = true;
        }
    }

    private void StartStrip(TWImageInfo info)
    {
        var res = TwainCaps.Fix(info.XResolution);
        _stripDpi = res > 0 ? (int)Math.Round(res) : _dpi;
        _strip = new StripImage(info.ImageWidth, info.ImageLength, info.BitsPerPixel, _whiteIsZero);
    }

    private void OnDataTransferred(object? sender, DataTransferredEventArgs e)
    {
        _job.Activity();
        if (_error != null) return;
        try
        {
            if (e.MemoryData != null)
            {
                if (_strip == null && e.ImageInfo is TWImageInfo info) StartStrip(info);
                if (_strip == null) throw new ScanException(ErrorCodes.Failed, "The scanner sent a page without describing it.");
                var m = e.MemoryInfo;
                _strip.Add(e.MemoryData, (int)m.Columns, (int)m.Rows, (int)m.XOffset, (int)m.YOffset, (int)m.BytesPerRow);
                if (_strip.Complete) FlushStrip(e);
            }
            else if (e.NativeData != IntPtr.Zero)
            {
                using var stream = e.GetNativeImageStream()
                    ?? throw new ScanException(ErrorCodes.Failed, "The scanner sent an image Paperwing can't read.");
                _job.AddPage(stream, _dpi, Side(e));
                _pages++;
            }
        }
        catch (Exception ex)
        {
            // Reported once the driver reaches the next page boundary
            _error = ex;
        }
    }

    private void FlushStrip(DataTransferredEventArgs? e)
    {
        var strip = _strip;
        _strip = null;
        if (strip == null || strip.IsEmpty || _error != null) return;
        try
        {
            using var bmp = strip.ToBitmap(_stripDpi);
            _job.AddPage(bmp, _stripDpi, Side(e));
            _pages++;
        }
        catch (Exception ex)
        {
            _error = ex;
        }
    }

    /// <summary>Front or back: the driver's page-side info if it gives it, else alternating</summary>
    private string Side(DataTransferredEventArgs? e)
    {
        if (!_duplex) return "front";
        if (_extInfo && e != null)
        {
            try
            {
                foreach (var info in e.GetExtImageInfo(ExtendedImageInfo.PageSide))
                {
                    if (info.InfoID != ExtendedImageInfo.PageSide || info.ReturnCode != ReturnCode.Success || info.NumItems < 1) continue;
                    // TWCS_TOP = 1 (front), TWCS_BOTTOM = 2 (back)
                    var side = (int)(info.Item.ToInt64() & 0xFFFF);
                    if (side == 1) return "front";
                    if (side == 2) return "back";
                }
            }
            catch (Exception)
            {
                // Not every driver answers
            }
        }
        return _pages % 2 == 0 ? "front" : "back";
    }

    private void OnTransferError(object? sender, TransferErrorEventArgs e)
    {
        _job.Activity();
        _error ??= e.Exception != null
            ? ErrorMap.From(e.Exception)
            : ErrorMap.FromTwain((int)(e.SourceStatus?.ConditionCode ?? ConditionCode.Bummer));
    }

    private void OnCancel()
    {
        if (_finished) return;
        var state = _session?.State ?? 0;
        if (state < 5 || _uiOpen)
        {
            // Not scanning yet (or only the driver's window is open): close now
            Finish(null);
            return;
        }
        if (state == 5)
        {
            // Waiting for the scanner's next page: let it get there, then stop
            _cancelTimer = new Timer(_ => _host.BeginInvoke(() => Finish(null)), null, CancelGrace, Timeout.InfiniteTimeSpan);
        }
        // States 6 and 7: the page in progress completes, then TransferReady stops the rest
    }

    private void Finish(Exception? error)
    {
        if (_finished) return;
        _finished = true;
        _error ??= error;
        if (_uiOpen)
        {
            _uiOpen = false;
            _job.ResumeWatchdog();
        }
        FlushStrip(null);
        if (_session != null) TwainDriver.Close(_session, _source);
        _done.TrySetResult(true);
    }
}
