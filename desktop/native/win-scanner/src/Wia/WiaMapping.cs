using System;
using System.Collections.Generic;
using System.Linq;

namespace Paperwing.Scan.Wia;

/// <summary>How a scan was set up: what the transfer needs to know</summary>
internal sealed class WiaSetup
{
    public int Dpi { get; set; }
    public bool Duplex { get; set; }
    /// <summary>The driver sends each sheet's back before its front</summary>
    public bool BackFirst { get; set; }
}

/// <summary>
/// WIA properties to and from the protocol: listing, caps and setting up a
/// scan. Pure logic over IWiaProps, so the unit tests cover it without a
/// scanner. The approach follows NAPS2's WIA driver (cyanfish/naps2,
/// NAPS2.Sdk/Scan/Internal/Wia), extended with the WIA 2.0 properties NAPS2
/// leaves alone (page size, auto crop/deskew, blank pages, multi-feed,
/// threshold, registration).
/// </summary>
internal static class WiaMapping
{
    /// <summary>One entry of the device list, or null if it isn't a scanner</summary>
    public static ScannerInfo? ToScanner(IWiaProps info)
    {
        var type = info.GetInt(WiaIds.DIP_DEV_TYPE);
        // Cameras and video devices are WIA devices too
        if (type != null && (type.Value >> 16) != WiaIds.STI_DEVICE_TYPE_SCANNER) return null;
        var id = info.GetString(WiaIds.DIP_DEV_ID);
        if (string.IsNullOrEmpty(id)) return null;
        var vendor = Clean(info.GetString(WiaIds.DIP_VEND_DESC));
        var description = Clean(info.GetString(WiaIds.DIP_DEV_DESC));
        var name = Clean(info.GetString(WiaIds.DIP_DEV_NAME));
        // Some driver problems leave the name as "No friendly name"
        if (name.Length == 0 || name.Equals("No friendly name", StringComparison.OrdinalIgnoreCase))
            name = description.Length > 0 ? description : "Unknown scanner";
        var port = info.GetString(WiaIds.DIP_PORT_NAME);
        var pnp = info.GetString(WiaIds.DIP_PNP_ID);
        var version = info.GetString(WiaIds.DIP_WIA_VERSION) ?? "";
        var api = version.StartsWith("1", StringComparison.Ordinal) ? "wia1" : "wia2";
        return new ScannerInfo("wia:" + id, name, "wia", api, vendor, description.Length > 0 ? description : name,
            Connection(port, pnp))
        {
            Instance = DeviceKey.SerialFromPnpId(pnp) ?? port,
        };
    }

    private static string Clean(string? s) => (s ?? "").Trim();

    /// <summary>usb, network or unknown, from the port and PnP ID</summary>
    public static string Connection(string? port, string? pnpId)
    {
        var p = port ?? "";
        var pnp = pnpId ?? "";
        if (p.StartsWith(@"\\.\Usbscan", StringComparison.OrdinalIgnoreCase) || pnp.StartsWith(@"USB\", StringComparison.OrdinalIgnoreCase))
            return "usb";
        string[] network = { "http:", "https:", "urn:uuid", "wsd", "dafwsd", "uuid:", "tcpip", "ip_" };
        if (network.Any(n => p.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0 || pnp.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0)
            || System.Text.RegularExpressions.Regex.IsMatch(p, @"\b\d{1,3}(\.\d{1,3}){3}\b"))
            return "network";
        return "unknown";
    }

    /// <summary>The scanner's area for a source, in thousandths of an inch (0 when unknown)</summary>
    public static (int Width, int Height) MaxArea(IWiaProps device, IWiaProps item, bool feeder, bool wia1)
    {
        int w = 0, h = 0;
        if (!wia1)
        {
            w = item.GetInt(WiaIds.IPS_MAX_HORIZONTAL_SIZE) ?? 0;
            h = item.GetInt(WiaIds.IPS_MAX_VERTICAL_SIZE) ?? 0;
        }
        else if (feeder)
        {
            w = device.GetInt(WiaIds.DPS_HORIZONTAL_SHEET_FEED_SIZE) ?? 0;
            h = device.GetInt(WiaIds.DPS_VERTICAL_SHEET_FEED_SIZE) ?? 0;
        }
        if (w <= 0) w = device.GetInt(WiaIds.DPS_HORIZONTAL_BED_SIZE) ?? 0;
        if (h <= 0 && !feeder) h = device.GetInt(WiaIds.DPS_VERTICAL_BED_SIZE) ?? 0;
        // Last resort: the largest extent at the current resolution
        if (w <= 0) w = FromExtent(item, WiaIds.IPS_XEXTENT, WiaIds.IPS_XRES, max: true);
        if (h <= 0 && !feeder) h = FromExtent(item, WiaIds.IPS_YEXTENT, WiaIds.IPS_YRES, max: true);
        return (Math.Max(0, w), Math.Max(0, h));
    }

    private static int FromExtent(IWiaProps item, int extentId, int resId, bool max)
    {
        var attr = item.GetAttr(extentId);
        var res = item.GetInt(resId) ?? 0;
        if (attr == null || !attr.IsRange || res <= 0) return 0;
        return (int)((long)(max ? attr.Max : attr.Min) * 1000 / res);
    }

    public static SourceCaps SourceCaps(IWiaProps device, IWiaProps item, string source, bool wia1)
    {
        var feeder = source == "feeder";
        var handling = device.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_CAPABILITIES) ?? 0;
        var caps = new SourceCaps
        {
            Id = source,
            CanPreview = !feeder,
            Duplex = feeder && (handling & WiaIds.DUPLEX) != 0,
        };

        var x = item.GetAttr(WiaIds.IPS_XRES);
        var y = item.GetAttr(WiaIds.IPS_YRES);
        if (x is { IsList: true } && x.Values.Length > 0)
        {
            var list = x.Values.Where(v => v > 0).ToList();
            if (y is { IsList: true } && y.Values.Length > 0)
            {
                var both = list.Intersect(y.Values).ToList();
                if (both.Count > 0) list = both;
            }
            caps.Resolutions = list;
        }
        else if (x is { IsRange: true } && x.Max > 0)
            caps.ResolutionRange = new RangeCap(x.Min, x.Max, Math.Max(1, x.Step), x.Nominal);
        else if (item.GetInt(WiaIds.IPS_XRES) is int current && current > 0)
            caps.Resolutions = new List<int> { current };

        caps.Colors = Colors(item.GetAttr(WiaIds.IPA_DATATYPE));

        var (maxW, maxH) = MaxArea(device, item, feeder, wia1);
        caps.MaxWidth = Geometry.FromThousandths(maxW);
        caps.MaxHeight = Geometry.FromThousandths(maxH);
        int minW, minH;
        if (!wia1)
        {
            minW = item.GetInt(WiaIds.IPS_MIN_HORIZONTAL_SIZE) ?? 0;
            minH = item.GetInt(WiaIds.IPS_MIN_VERTICAL_SIZE) ?? 0;
        }
        else
        {
            minW = feeder ? device.GetInt(WiaIds.DPS_MIN_HORIZONTAL_SHEET_FEED_SIZE) ?? 0 : 0;
            minH = feeder ? device.GetInt(WiaIds.DPS_MIN_VERTICAL_SHEET_FEED_SIZE) ?? 0 : 0;
        }
        if (minW <= 0) minW = FromExtent(item, WiaIds.IPS_XEXTENT, WiaIds.IPS_XRES, max: false);
        if (minH <= 0) minH = FromExtent(item, WiaIds.IPS_YEXTENT, WiaIds.IPS_YRES, max: false);
        caps.MinWidth = Geometry.FromThousandths(minW);
        caps.MinHeight = Geometry.FromThousandths(minH);

        // WIA 2.0 item properties (on WIA 1.0 these IDs can mean other things)
        var pageSizes = wia1 ? null : item.GetAttr(WiaIds.IPS_PAGE_SIZE);
        if (pageSizes is { IsList: true } && pageSizes.Values.Length > 0)
        {
            caps.PaperSizes = PaperSizes.FromWia(pageSizes.Values, caps.MaxWidth, caps.MaxHeight);
            caps.AutoSize = pageSizes.Values.Contains(PaperSizes.WiaPageAuto);
        }
        if (caps.PaperSizes.Count == 0) caps.PaperSizes = PaperSizes.CommonFitting(caps.MaxWidth, caps.MaxHeight);
        if (!wia1)
        {
            caps.AutoDeskew = Allows(item.GetAttr(WiaIds.IPS_AUTO_DESKEW), WiaIds.AUTO_DESKEW_ON);
            caps.AutoCrop = Allows(item.GetAttr(WiaIds.IPS_AUTO_CROP), WiaIds.AUTO_CROP_SINGLE);
            caps.BlankPageSkip = feeder && Allows(item.GetAttr(WiaIds.IPS_BLANK_PAGES), WiaIds.BLANK_PAGE_DISCARD);
            caps.DoubleFeed = feeder && Allows(item.GetAttr(WiaIds.IPS_MULTI_FEED), WiaIds.MULTI_FEED_DETECT_STOP_ERROR);
        }
        // Black and white pages come with a palette: the helper inverts them
        caps.Invert = caps.Colors.Contains("bw");
        caps.Brightness = Range(item.GetAttr(WiaIds.IPS_BRIGHTNESS));
        caps.Contrast = Range(item.GetAttr(WiaIds.IPS_CONTRAST));
        caps.Threshold = caps.Colors.Contains("bw") ? Range(item.GetAttr(WiaIds.IPS_THRESHOLD)) : null;
        if (feeder && device.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_STATUS) is int status)
            caps.FeederLoaded = (status & WiaIds.FEED_READY) != 0;
        return caps;
    }

    /// <summary>IPA_DATATYPE's valid values as the protocol's color modes</summary>
    public static List<string> Colors(WiaAttr? dataType)
    {
        var values = dataType != null && (dataType.IsList || dataType.IsFlag) ? dataType.Values : Array.Empty<int>();
        if (values.Length == 0) return new List<string> { "color", "gray", "bw" };
        var colors = new List<string>();
        if (values.Contains(WiaIds.DATA_COLOR)) colors.Add("color");
        if (values.Contains(WiaIds.DATA_GRAYSCALE)) colors.Add("gray");
        if (values.Contains(WiaIds.DATA_THRESHOLD) || values.Contains(WiaIds.DATA_DITHER)) colors.Add("bw");
        return colors;
    }

    private static bool Allows(WiaAttr? attr, int value)
    {
        if (attr == null) return false;
        if (attr.IsList) return attr.Values.Contains(value);
        if (attr.IsRange) return value >= attr.Min && value <= attr.Max;
        return attr.Writable;
    }

    private static RangeCap? Range(WiaAttr? attr) =>
        attr is { IsRange: true } && attr.Max > attr.Min
            ? new RangeCap(attr.Min, attr.Max, Math.Max(1, attr.Step), attr.Nominal)
            : null;

    private static Align Registration(int? value) => value switch
    {
        WiaIds.CENTERED => Align.Center,
        WiaIds.RIGHT_JUSTIFIED => Align.End,
        _ => Align.Start,
    };

    /// <summary>
    /// Sets up the source, color, area, resolution and image options. A
    /// setting the driver refuses is skipped (as NAPS2 does): the scan still
    /// works, and Paperwing can apply that setting afterwards.
    /// </summary>
    public static WiaSetup Configure(IWiaProps device, IWiaProps item, ScanOptions o, bool wia1, bool preview)
    {
        var feeder = o.Feeder;
        var duplex = feeder && o.Duplex;

        // Source. WIA 1.0: one item; the device chooses the feeder (and scans
        // one page per transfer). WIA 2.0: a "Feeder" item, all pages at once.
        if (wia1)
        {
            device.TrySet(WiaIds.DPS_DOCUMENT_HANDLING_SELECT,
                feeder ? WiaIds.FEEDER | (duplex ? WiaIds.DUPLEX : 0) : WiaIds.FLATBED);
            if (feeder) device.TrySet(WiaIds.DPS_PAGES, 1);
            if (device.Has(WiaIds.DPS_PREVIEW))
                device.TrySet(WiaIds.DPS_PREVIEW, preview ? WiaIds.PREVIEW_SCAN : WiaIds.FINAL_SCAN);
        }
        else
        {
            if (feeder)
            {
                item.TrySet(WiaIds.IPS_DOCUMENT_HANDLING_SELECT, duplex ? WiaIds.DUPLEX : WiaIds.FRONT_ONLY);
                item.TrySet(WiaIds.IPS_PAGES, 0);
            }
            if (item.Has(WiaIds.IPS_PREVIEW))
                item.TrySet(WiaIds.IPS_PREVIEW, preview ? WiaIds.PREVIEW_SCAN : WiaIds.FINAL_SCAN);
        }

        // Color first: the valid resolutions can depend on it
        if (o.Color != null)
        {
            var wanted = o.Color switch
            {
                "color" => WiaIds.DATA_COLOR,
                "gray" => WiaIds.DATA_GRAYSCALE,
                _ => WiaIds.DATA_THRESHOLD,
            };
            if (!item.TrySet(WiaIds.IPA_DATATYPE, wanted) && wanted == WiaIds.DATA_THRESHOLD)
                item.TrySet(WiaIds.IPA_DATATYPE, WiaIds.DATA_DITHER);
        }

        // An area or paper size given (or a preview: the whole glass); otherwise
        // the driver's own page size stays, as a feeder's default page size
        // is usually right and its full length isn't
        var setArea = !o.AutoArea && (o.Area != null || o.Paper != null || preview);

        // Automatic page size: the driver finds the page
        var autoApplied = false;
        if (!wia1)
        {
            var pageSize = item.GetAttr(WiaIds.IPS_PAGE_SIZE);
            if (o.AutoArea)
            {
                if (pageSize is { IsList: true } && pageSize.Values.Contains(PaperSizes.WiaPageAuto))
                    autoApplied = item.TrySet(WiaIds.IPS_PAGE_SIZE, PaperSizes.WiaPageAuto);
                if (!autoApplied && Allows(item.GetAttr(WiaIds.IPS_AUTO_CROP), WiaIds.AUTO_CROP_SINGLE))
                    autoApplied = item.TrySet(WiaIds.IPS_AUTO_CROP, WiaIds.AUTO_CROP_SINGLE);
            }
            else if (setArea)
            {
                // Custom: the extents below decide the area
                if (pageSize != null) item.TrySet(WiaIds.IPS_PAGE_SIZE, PaperSizes.WiaPageCustom);
                if (item.Has(WiaIds.IPS_AUTO_CROP)) item.TrySet(WiaIds.IPS_AUTO_CROP, WiaIds.AUTO_CROP_DISABLED);
            }
        }

        var xDpi = SetResolution(item, WiaIds.IPS_XRES, o.Dpi);
        var yDpi = SetResolution(item, WiaIds.IPS_YRES, o.Dpi ?? (xDpi > 0 ? xDpi : null));

        if (setArea && xDpi > 0 && yDpi > 0)
        {
            var (maxW, maxH) = MaxArea(device, item, feeder, wia1);
            var across = feeder
                ? Registration(wia1 ? device.GetInt(WiaIds.DPS_SHEET_FEEDER_REGISTRATION) : item.GetInt(WiaIds.IPS_SHEET_FEEDER_REGISTRATION))
                : Registration(device.GetInt(WiaIds.DPS_HORIZONTAL_BED_REGISTRATION));
            var down = feeder ? Align.Start : Registration(device.GetInt(WiaIds.DPS_VERTICAL_BED_REGISTRATION));
            var area = Geometry.ResolveArea(o, Geometry.FromThousandths(maxW), Geometry.FromThousandths(maxH), across, down);
            var maxWpx = Limit(Geometry.ThousandthsToPixels(maxW, xDpi), item.GetAttr(WiaIds.IPS_XEXTENT));
            var maxHpx = Limit(Geometry.ThousandthsToPixels(maxH, yDpi), item.GetAttr(WiaIds.IPS_YEXTENT));
            var (xPos, yPos, xExt, yExt) = Geometry.WiaWindow(area, xDpi, yDpi, maxWpx, maxHpx, o.OffsetWidth);
            // Position 0 first, so a large extent is valid whatever the old position
            item.TrySet(WiaIds.IPS_XPOS, 0);
            item.TrySet(WiaIds.IPS_YPOS, 0);
            item.TrySet(WiaIds.IPS_XEXTENT, xExt);
            item.TrySet(WiaIds.IPS_YEXTENT, yExt);
            item.TrySet(WiaIds.IPS_XPOS, xPos);
            item.TrySet(WiaIds.IPS_YPOS, yPos);
        }

        SetInRange(item, WiaIds.IPS_BRIGHTNESS, o.Brightness);
        SetInRange(item, WiaIds.IPS_CONTRAST, o.Contrast);
        if (o.Color == "bw") SetInRange(item, WiaIds.IPS_THRESHOLD, o.Threshold);

        if (!wia1)
        {
            if (o.AutoDeskew is bool deskew && item.Has(WiaIds.IPS_AUTO_DESKEW))
                item.TrySet(WiaIds.IPS_AUTO_DESKEW, deskew ? WiaIds.AUTO_DESKEW_ON : WiaIds.AUTO_DESKEW_OFF);
            if (feeder && o.BlankPageSkip is bool blank && item.Has(WiaIds.IPS_BLANK_PAGES))
                item.TrySet(WiaIds.IPS_BLANK_PAGES, blank ? WiaIds.BLANK_PAGE_DISCARD : WiaIds.BLANK_PAGE_DETECTION_DISABLED);
            if (feeder && o.DoubleFeedStop is bool stop && item.Has(WiaIds.IPS_MULTI_FEED))
                item.TrySet(WiaIds.IPS_MULTI_FEED, stop ? WiaIds.MULTI_FEED_DETECT_STOP_ERROR : WiaIds.MULTI_FEED_DETECT_DISABLED);
        }

        var select = wia1 ? device.GetInt(WiaIds.DPS_DOCUMENT_HANDLING_SELECT) : item.GetInt(WiaIds.IPS_DOCUMENT_HANDLING_SELECT);
        return new WiaSetup
        {
            Dpi = xDpi,
            Duplex = duplex,
            BackFirst = duplex && select is int s && (s & WiaIds.BACK_FIRST) != 0,
        };
    }

    /// <summary>The resolution nearest the one wanted that the driver accepts; the current one if none wanted</summary>
    public static int SetResolution(IWiaProps item, int propId, int? wanted)
    {
        var current = item.GetInt(propId) ?? 0;
        if (wanted is not int dpi) return current;
        var attr = item.GetAttr(propId);
        var value = dpi;
        if (attr is { IsList: true } && attr.Values.Length > 0)
            value = Geometry.Closest(dpi, attr.Values);
        else if (attr is { IsRange: true } && attr.Max > 0)
            value = (int)Geometry.Snap(dpi, attr.Min, attr.Max, attr.Step);
        return item.TrySet(propId, value) ? value : current;
    }

    /// <summary>A setting in the driver's units, clamped and snapped to its range</summary>
    public static void SetInRange(IWiaProps item, int propId, double? wanted)
    {
        if (wanted is not double v || !item.Has(propId)) return;
        var attr = item.GetAttr(propId);
        if (attr is { IsRange: true } && attr.Max > attr.Min)
            v = Geometry.Snap(v, attr.Min, attr.Max, attr.Step);
        item.TrySet(propId, (int)Math.Round(v, MidpointRounding.AwayFromZero));
    }

    private static int Limit(int pixels, WiaAttr? extent)
    {
        if (extent is { IsRange: true } && extent.Max > 0)
            return pixels > 0 ? Math.Min(pixels, extent.Max) : extent.Max;
        return pixels;
    }
}
