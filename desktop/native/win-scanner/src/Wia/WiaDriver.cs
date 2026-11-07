using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using NAPS2.Wia;

namespace Paperwing.Scan.Wia;

/// <summary>
/// Windows Image Acquisition through NAPS2.Wia: the WIA 2.0 API (duplex,
/// feeder items), falling back to WIA 1.0 when a driver rejects it, as NAPS2
/// does. Scans run on an MTA thread like NAPS2's; the scanner's own window
/// (nativeUi) on an STA thread, as Windows' common dialogs need.
/// </summary>
internal sealed class WiaDriver : IScanDriver
{
    private const uint E_INVALIDARG = 0x80070057;
    private const uint PAPER_EMPTY = 0x80210003;
    /// <summary>Undocumented; NAPS2 found it means "no more pages"</summary>
    private const uint NO_MORE_PAGES = 0x00210001;

    public string IdPrefix => "wia";

    public List<ScannerInfo> List()
    {
        using var manager = OpenManager(WiaVersion.Wia20);
        var result = new List<ScannerInfo>();
        foreach (var info in manager.GetDeviceInfos())
        {
            using (info)
            {
                var scanner = WiaMapping.ToScanner(new NativeWiaProps(info.Properties));
                if (scanner != null) result.Add(scanner);
            }
        }
        return result;
    }

    public Dictionary<string, object?> Caps(string localId)
    {
        try
        {
            using var manager = OpenManager(WiaVersion.Wia20);
            using var device = OpenDevice(manager, localId);
            var dev = new NativeWiaProps(device.Properties);
            var wia1 = device.Version == WiaVersion.Wia10;
            var handling = dev.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_CAPABILITIES) ?? 0;
            var items = device.GetSubItems();
            try
            {
                var sources = new List<SourceCaps>();
                var flatbed = FindItem(items, false, handling, wia1);
                var feeder = FindItem(items, true, handling, wia1);
                if (flatbed != null) sources.Add(WiaMapping.SourceCaps(dev, new NativeWiaProps(flatbed.Properties), "flatbed", wia1));
                if (feeder != null) sources.Add(WiaMapping.SourceCaps(dev, new NativeWiaProps(feeder.Properties), "feeder", wia1));
                return new Dictionary<string, object?>
                {
                    ["type"] = "caps",
                    ["driver"] = "wia",
                    ["api"] = wia1 ? "wia1" : "wia2",
                    ["nativeUi"] = true,
                    ["sources"] = sources.Select(s => s.ToJson()).ToList(),
                };
            }
            finally
            {
                foreach (var item in items) item.Dispose();
            }
        }
        catch (WiaException e)
        {
            throw ErrorMap.FromHResult(e.ErrorCode);
        }
    }

    public void Scan(string localId, ScanJob job)
    {
        try
        {
            if (job.Options.NativeUi && !job.Preview)
            {
                RunSta(() => NativeUiScan(localId, job));
                return;
            }
            try
            {
                ScanWith(WiaVersion.Wia20, localId, job);
            }
            catch (WiaException e) when (e.ErrorCode == E_INVALIDARG && job.Pages == 0 && !job.CancelRequested)
            {
                // Some older drivers only work through the WIA 1.0 API
                ScanWith(WiaVersion.Wia10, localId, job);
            }
        }
        catch (WiaException e)
        {
            throw ErrorMap.FromHResult(e.ErrorCode);
        }
    }

    private static WiaDeviceManager OpenManager(WiaVersion version)
    {
        try
        {
            return new WiaDeviceManager(version);
        }
        catch (WiaException e)
        {
            throw ErrorMap.FromHResult(e.ErrorCode);
        }
    }

    /// <summary>The device, if it's (still) there: an unknown ID is "no scanner", not a driver error</summary>
    private static WiaDevice OpenDevice(WiaDeviceManager manager, string id)
    {
        var listed = false;
        foreach (var info in manager.GetDeviceInfos())
        {
            using (info)
                listed |= new NativeWiaProps(info.Properties).GetString(WiaIds.DIP_DEV_ID) == id;
        }
        if (!listed) throw ErrorMap.NoScanner();
        return manager.FindDevice(id);
    }

    /// <summary>
    /// The flatbed or feeder item. WIA 2.0 names them "Flatbed" and
    /// "Feeder"; WIA 1.0 has one item for both, chosen with a device setting.
    /// </summary>
    private static WiaItem? FindItem(List<WiaItem> items, bool feeder, int handling, bool wia1)
    {
        var supported = handling == 0 ? !feeder : (handling & (feeder ? WiaIds.FEEDER : WiaIds.FLATBED)) != 0;
        if (wia1) return supported ? items.FirstOrDefault() : null;
        var name = feeder ? "Feeder" : "Flatbed";
        var match = items.FirstOrDefault(i =>
            string.Equals(new NativeWiaProps(i.Properties).GetString(WiaIds.IPA_ITEM_NAME), name, StringComparison.OrdinalIgnoreCase));
        if (match != null) return match;
        // A driver with one item under another name: use it for what the device says it has
        return items.Count == 1 && supported ? items[0] : null;
    }

    private static void ScanWith(WiaVersion version, string id, ScanJob job)
    {
        using var manager = new WiaDeviceManager(version);
        using var device = OpenDevice(manager, id);
        var dev = new NativeWiaProps(device.Properties);
        var wia1 = device.Version == WiaVersion.Wia10;
        var handling = dev.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_CAPABILITIES) ?? 0;
        var items = device.GetSubItems();
        try
        {
            var options = job.Options;
            if (options.Source == null)
            {
                var hasFlatbed = handling == 0 || (handling & WiaIds.FLATBED) != 0;
                options = options.WithSource(hasFlatbed ? "flatbed" : "feeder");
            }
            var item = FindItem(items, options.Feeder, handling, wia1);
            if (item == null)
                throw ErrorMap.Unsupported(job.Preview ? "previews (it has no flatbed)" : options.Feeder ? "a document feeder" : "a flatbed");
            var props = new NativeWiaProps(item.Properties);
            if (job.Preview)
            {
                var caps = WiaMapping.SourceCaps(dev, props, "flatbed", wia1);
                options = options.ForPreview(options.Dpi ?? Geometry.PreviewDpi(caps.Resolutions, caps.ResolutionRange));
            }
            if (options.Feeder && options.Duplex && (handling & WiaIds.DUPLEX) == 0)
                throw ErrorMap.Unsupported("two-sided scanning");
            var setup = WiaMapping.Configure(dev, props, options, wia1, job.Preview);
            Transfer(item, setup, options.Feeder, wia1, job);
        }
        finally
        {
            foreach (var i in items) i.Dispose();
        }
    }

    /// <summary>
    /// Runs the transfer, saving each page as it comes. A cancel lets the
    /// page being scanned finish, then stops the transfer.
    /// </summary>
    private static void Transfer(WiaItem item, WiaSetup setup, bool feeder, bool wia1, ScanJob job)
    {
        using var transfer = item.StartTransfer();
        var index = 0;
        Exception? pageError = null;
        transfer.PageScanned += (_, e) =>
        {
            try
            {
                using var stream = e.Stream;
                if (stream.Length == 0) return;
                var front = !setup.Duplex || ((index % 2 == 0) != setup.BackFirst);
                index++;
                job.AddPage(stream, setup.Dpi, front ? "front" : "back");
                if (job.CancelRequested || job.Preview) transfer.Cancel();
            }
            catch (Exception ex)
            {
                pageError ??= ex;
                transfer.Cancel();
            }
        };
        transfer.Progress += (_, _) => job.Activity();
        try
        {
            transfer.Download();
            // WIA 1.0 feeders scan a page per transfer: repeat until the feeder is empty
            if (wia1 && feeder)
            {
                while (!job.CancelRequested && pageError == null)
                {
                    if (!transfer.Download()) break;
                }
            }
        }
        catch (WiaException e) when (e.ErrorCode == NO_MORE_PAGES || (e.ErrorCode == PAPER_EMPTY && index > 0))
        {
            // The feeder ran out after some pages: how a feeder scan ends
        }
        if (pageError != null) throw pageError;
        if (index == 0 && feeder && !job.CancelRequested) throw ErrorMap.FeederEmpty();
    }

    /// <summary>
    /// The scanner's own window: WIA 2.0's scan dialog writes the pages to
    /// files (in a folder inside OutDir), which become the pages. Drivers that
    /// refuse it get WIA 1.0's dialog, which sets up a normal transfer.
    /// </summary>
    private static void NativeUiScan(string id, ScanJob job)
    {
        var thread = Native.GetCurrentThreadId();
        // Cancel closes the dialog
        job.Cancelled += () => Native.CloseThreadWindows(thread);
        job.SuspendWatchdog();
        try
        {
            using var manager = new WiaDeviceManager(WiaVersion.Wia20);
            using var device = OpenDevice(manager, id);
            var folder = job.DriverFolder();
            string[]? files;
            try
            {
                files = manager.PromptForImage(device, job.ParentWindow, folder);
            }
            catch (WiaException e) when (e.ErrorCode == E_INVALIDARG)
            {
                NativeUiWia1(id, job);
                return;
            }
            if (files == null)
            {
                // Closed without scanning
                job.RequestCancel();
                return;
            }
            foreach (var file in files)
            {
                var full = Path.GetFullPath(file);
                if (!File.Exists(full) || !string.Equals(Path.GetDirectoryName(full), folder, StringComparison.OrdinalIgnoreCase))
                    continue;
                try
                {
                    job.AddPagesFromFile(full);
                }
                finally
                {
                    File.Delete(full);
                }
            }
        }
        finally
        {
            job.ResumeWatchdog();
        }
    }

    private static void NativeUiWia1(string id, ScanJob job)
    {
        using var manager = new WiaDeviceManager(WiaVersion.Wia10);
        using var device = OpenDevice(manager, id);
        using var item = device.PromptToConfigure(job.ParentWindow);
        if (item == null)
        {
            job.RequestCancel();
            return;
        }
        var dev = new NativeWiaProps(device.Properties);
        var feeder = ((dev.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_SELECT) ?? 0) & WiaIds.FEEDER) != 0;
        var setup = new WiaSetup { Dpi = new NativeWiaProps(item.Properties).GetInt(WiaIds.IPS_XRES) ?? 0 };
        job.ResumeWatchdog();
        try
        {
            Transfer(item, setup, feeder, true, job);
        }
        finally
        {
            job.SuspendWatchdog();
        }
    }

    private static void RunSta(Action action)
    {
        Exception? error = null;
        var t = new Thread(() =>
        {
            try
            {
                action();
            }
            catch (Exception e)
            {
                error = e;
            }
        })
        { IsBackground = true, Name = "WIA dialog" };
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (error != null) throw error is WiaException w ? ErrorMap.FromHResult(w.ErrorCode) : error;
    }
}
