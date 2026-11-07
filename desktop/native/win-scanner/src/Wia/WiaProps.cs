using System;
using System.Linq;
using NAPS2.Wia;

namespace Paperwing.Scan.Wia;

/// <summary>WIA property IDs and values (WiaDef.h in the Windows SDK)</summary>
internal static class WiaIds
{
    // Device information
    public const int DIP_DEV_ID = 2;
    public const int DIP_VEND_DESC = 3;
    public const int DIP_DEV_DESC = 4;
    public const int DIP_DEV_TYPE = 5;
    public const int DIP_PORT_NAME = 6;
    public const int DIP_DEV_NAME = 7;
    public const int DIP_WIA_VERSION = 14;
    public const int DIP_PNP_ID = 16;

    // Device (WIA 1.0: also where the source and the bed sizes are)
    public const int DPS_HORIZONTAL_BED_SIZE = 3074;
    public const int DPS_VERTICAL_BED_SIZE = 3075;
    public const int DPS_HORIZONTAL_SHEET_FEED_SIZE = 3076;
    public const int DPS_VERTICAL_SHEET_FEED_SIZE = 3077;
    public const int DPS_SHEET_FEEDER_REGISTRATION = 3078;
    public const int DPS_HORIZONTAL_BED_REGISTRATION = 3079;
    public const int DPS_VERTICAL_BED_REGISTRATION = 3080;
    public const int DPS_DOCUMENT_HANDLING_CAPABILITIES = 3086;
    public const int DPS_DOCUMENT_HANDLING_STATUS = 3087;
    public const int DPS_DOCUMENT_HANDLING_SELECT = 3088;
    public const int DPS_PAGES = 3096;
    public const int DPS_PREVIEW = 3100;
    /// <summary>WIA 1.0 only: the same ID is something else on WIA 2.0 items</summary>
    public const int DPS_MIN_HORIZONTAL_SHEET_FEED_SIZE = 3104;
    public const int DPS_MIN_VERTICAL_SHEET_FEED_SIZE = 3105;

    // Item
    public const int IPA_ITEM_NAME = 4098;
    public const int IPA_DATATYPE = 4103;
    public const int IPA_DEPTH = 4104;
    public const int IPS_XRES = 6147;
    public const int IPS_YRES = 6148;
    public const int IPS_XPOS = 6149;
    public const int IPS_YPOS = 6150;
    public const int IPS_XEXTENT = 6151;
    public const int IPS_YEXTENT = 6152;
    public const int IPS_BRIGHTNESS = 6154;
    public const int IPS_CONTRAST = 6155;
    public const int IPS_THRESHOLD = 6159;
    public const int IPS_MAX_HORIZONTAL_SIZE = 6165;
    public const int IPS_MAX_VERTICAL_SIZE = 6166;
    public const int IPS_MIN_HORIZONTAL_SIZE = 6167;
    public const int IPS_MIN_VERTICAL_SIZE = 6168;
    public const int IPS_SHEET_FEEDER_REGISTRATION = 3078;
    public const int IPS_DOCUMENT_HANDLING_SELECT = 3088;
    public const int IPS_PAGES = 3096;
    public const int IPS_PAGE_SIZE = 3097;
    public const int IPS_PREVIEW = 3100;
    public const int IPS_AUTO_DESKEW = 3107;
    public const int IPS_BLANK_PAGES = 4167;
    public const int IPS_MULTI_FEED = 4168;
    public const int IPS_AUTO_CROP = 4170;

    // DOCUMENT_HANDLING_CAPABILITIES / _SELECT
    public const int FEEDER = 0x1;
    public const int FLATBED = 0x2;
    public const int DUPLEX = 0x4;
    public const int FRONT_FIRST = 0x8;
    public const int BACK_FIRST = 0x10;
    public const int FRONT_ONLY = 0x20;
    // DOCUMENT_HANDLING_STATUS
    public const int FEED_READY = 0x1;

    // IPA_DATATYPE
    public const int DATA_THRESHOLD = 0;
    public const int DATA_DITHER = 1;
    public const int DATA_GRAYSCALE = 2;
    public const int DATA_COLOR = 3;

    // Registration (where paper lines up)
    public const int LEFT_JUSTIFIED = 0;
    public const int CENTERED = 1;
    public const int RIGHT_JUSTIFIED = 2;

    public const int AUTO_DESKEW_ON = 0;
    public const int AUTO_DESKEW_OFF = 1;
    public const int BLANK_PAGE_DETECTION_DISABLED = 0;
    public const int BLANK_PAGE_DISCARD = 1;
    public const int MULTI_FEED_DETECT_DISABLED = 0;
    public const int MULTI_FEED_DETECT_STOP_ERROR = 1;
    public const int AUTO_CROP_DISABLED = 0;
    public const int AUTO_CROP_SINGLE = 1;
    public const int FINAL_SCAN = 0;
    public const int PREVIEW_SCAN = 1;

    /// <summary>StiDeviceTypeScanner, the high word of DIP_DEV_TYPE</summary>
    public const int STI_DEVICE_TYPE_SCANNER = 1;
}

/// <summary>A property's valid values: a list, a range or flags</summary>
internal sealed class WiaAttr
{
    public bool IsList { get; set; }
    public bool IsRange { get; set; }
    public bool IsFlag { get; set; }
    public bool Writable { get; set; }
    public int Min { get; set; }
    public int Max { get; set; }
    public int Step { get; set; }
    public int Nominal { get; set; }
    public int[] Values { get; set; } = Array.Empty<int>();
}

/// <summary>
/// A WIA item's (or device's) properties. The mapping code works against
/// this, so it's tested without a scanner (WIA can't be faked).
/// </summary>
internal interface IWiaProps
{
    bool Has(int id);
    int? GetInt(int id);
    string? GetString(int id);
    WiaAttr? GetAttr(int id);
    /// <summary>Sets a value; false if the driver refused it or lacks the property</summary>
    bool TrySet(int id, int value);
}

/// <summary>IWiaProps over NAPS2.Wia's property storage</summary>
internal sealed class NativeWiaProps : IWiaProps
{
    private readonly WiaPropertyCollection _props;

    public NativeWiaProps(WiaPropertyCollection props)
    {
        _props = props;
    }

    public bool Has(int id) => _props.GetOrNull(id) != null;

    public int? GetInt(int id)
    {
        try
        {
            var p = _props.GetOrNull(id);
            return p != null && p.Type == WiaPropertyType.I4 ? (int)p.Value : null;
        }
        catch (Exception e) when (e is WiaException or NotImplementedException or InvalidCastException)
        {
            return null;
        }
    }

    public string? GetString(int id)
    {
        try
        {
            var p = _props.GetOrNull(id);
            return p != null && p.Type == WiaPropertyType.BSTR ? p.Value as string : null;
        }
        catch (Exception e) when (e is WiaException or NotImplementedException)
        {
            return null;
        }
    }

    public WiaAttr? GetAttr(int id)
    {
        try
        {
            var p = _props.GetOrNull(id);
            if (p == null) return null;
            var a = p.Attributes;
            return new WiaAttr
            {
                IsList = a.Flags.HasFlag(WiaPropertyFlags.List),
                IsRange = a.Flags.HasFlag(WiaPropertyFlags.Range),
                IsFlag = a.Flags.HasFlag(WiaPropertyFlags.Flag),
                Writable = a.Flags.HasFlag(WiaPropertyFlags.Write),
                Min = a.Min,
                Max = a.Max,
                Step = a.Step,
                Nominal = a.Nom,
                Values = a.Values?.OfType<int>().ToArray() ?? Array.Empty<int>(),
            };
        }
        catch (Exception e) when (e is WiaException or InvalidCastException)
        {
            return null;
        }
    }

    public bool TrySet(int id, int value)
    {
        try
        {
            var p = _props.GetOrNull(id);
            if (p == null || p.Type != WiaPropertyType.I4) return false;
            p.Value = value;
            return true;
        }
        catch (Exception e) when (e is WiaException or ArgumentException or NotImplementedException)
        {
            return false;
        }
    }
}
