using System;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Paperwing.Scan;

/// <summary>The error codes of the protocol (see PLAN-SCANNING-AND-CERTIFICATES.md)</summary>
internal static class ErrorCodes
{
    public const string NoScanner = "no-scanner";
    public const string Offline = "offline";
    public const string Busy = "busy";
    public const string PaperJam = "paper-jam";
    public const string FeederEmpty = "feeder-empty";
    public const string DoubleFeed = "double-feed";
    public const string CoverOpen = "cover-open";
    public const string Unsupported = "unsupported";
    public const string Blocked = "blocked";
    public const string Failed = "failed";
}

/// <summary>An error to report as {"type":"error","code","message"}</summary>
internal sealed class ScanException : Exception
{
    public ScanException(string code, string message, Exception? inner = null) : base(message, inner)
    {
        Code = code;
    }

    public string Code { get; }
}

/// <summary>Driver errors (WIA HRESULTs, TWAIN condition codes) as protocol errors</summary>
internal static class ErrorMap
{
    public static ScanException NoScanner() =>
        new(ErrorCodes.NoScanner, "The scanner wasn't found. Check that it's connected and turned on.");

    public static ScanException Offline() =>
        new(ErrorCodes.Offline, "The scanner isn't responding. Check that it's turned on and connected.");

    public static ScanException Busy() =>
        new(ErrorCodes.Busy, "The scanner is busy. Wait a moment, then try again.");

    public static ScanException FeederEmpty() =>
        new(ErrorCodes.FeederEmpty, "There's no paper in the document feeder.");

    public static ScanException Unsupported(string what) =>
        new(ErrorCodes.Unsupported, $"The scanner doesn't support {what}.");

    /// <summary>
    /// WIA error HRESULTs (WiaDef.h: MAKE_HRESULT(SEVERITY_ERROR, FACILITY_WIA, n))
    /// and the system errors WIA passes through.
    /// </summary>
    public static ScanException FromHResult(uint hr)
    {
        switch (hr)
        {
            case 0x80210002: // WIA_ERROR_PAPER_JAM
            case 0x80210004: // WIA_ERROR_PAPER_PROBLEM
                return new(ErrorCodes.PaperJam, "Paper is jammed in the scanner. Clear it, then try again.");
            case 0x80210003: // WIA_ERROR_PAPER_EMPTY
                return FeederEmpty();
            case 0x80210005: // WIA_ERROR_OFFLINE
            case 0x8021000A: // WIA_ERROR_DEVICE_COMMUNICATION
            case 0x80070015: // ERROR_NOT_READY
            case 0x8007001F: // ERROR_GEN_FAILURE (unplugged mid-scan)
            case 0x80070079: // ERROR_SEM_TIMEOUT
                return Offline();
            case 0x80210006: // WIA_ERROR_BUSY
            case 0x8021000D: // WIA_ERROR_DEVICE_LOCKED
            case 0x80210013: // WIA_ERROR_NETWORK_RESERVATION_FAILED
                return Busy();
            case 0x80210007: // WIA_ERROR_WARMING_UP
                return new(ErrorCodes.Busy, "The scanner is warming up. Try again in a moment.");
            case 0x80210009: // WIA_ERROR_ITEM_DELETED
            case 0x80210015: // WIA_S_NO_DEVICE_AVAILABLE
                return NoScanner();
            case 0x80210010: // WIA_ERROR_COVER_OPEN (16)
            case 0x80210016: // (NAPS2 uses this value for "cover open"; harmless to accept too)
                return new(ErrorCodes.CoverOpen, "The scanner's cover is open. Close it, then try again.");
            case 0x80210014: // WIA_ERROR_MULTI_FEED (20)
                return new(ErrorCodes.DoubleFeed, "Two sheets went through the feeder together. Load them again, then try again.");
            case 0x8021000B: // WIA_ERROR_INVALID_COMMAND
            case 0x8021000C: // WIA_ERROR_INCORRECT_HARDWARE_SETTING
            case 0x80070057: // E_INVALIDARG
            case 0x80004001: // E_NOTIMPL
                return Unsupported("these settings");
            case 0x80070005: // E_ACCESSDENIED
            case 0x80070422: // ERROR_SERVICE_DISABLED (the Windows Image Acquisition service)
            case 0x800704EC: // ERROR_ACCESS_DISABLED_BY_POLICY
                return new(ErrorCodes.Blocked,
                    "Windows blocked access to the scanner (the Windows Image Acquisition service is turned off, or a policy denies it).");
            case 0x80210008: // WIA_ERROR_USER_INTERVENTION
                return new(ErrorCodes.Failed, "The scanner needs attention. Check its display or lights, then try again.");
            case 0x80210011: // WIA_ERROR_LAMP_OFF
                return new(ErrorCodes.Failed, "The scanner's lamp is off. Turn it on, then try again.");
            default:
                return new(ErrorCodes.Failed, $"The scanner reported an error (0x{hr.ToString("X8", CultureInfo.InvariantCulture)}).");
        }
    }

    /// <summary>TWAIN condition codes (TWCC_*, TWAIN 2.4 specification, chapter 11)</summary>
    public static ScanException FromTwain(int conditionCode)
    {
        switch (conditionCode)
        {
            case 3: // TWCC_NODS
                return NoScanner();
            case 4: // TWCC_MAXCONNECTIONS: another program is using it
                return Busy();
            case 20: // TWCC_PAPERJAM
                return new(ErrorCodes.PaperJam, "Paper is jammed in the scanner. Clear it, then try again.");
            case 21: // TWCC_PAPERDOUBLEFEED
                return new(ErrorCodes.DoubleFeed, "Two sheets went through the feeder together. Load them again, then try again.");
            case 23: // TWCC_CHECKDEVICEONLINE
                return Offline();
            case 24: // TWCC_INTERLOCK
                return new(ErrorCodes.CoverOpen, "The scanner's cover is open. Close it, then try again.");
            case 29: // TWCC_NOMEDIA
                return FeederEmpty();
            case 6: // TWCC_BADCAP
            case 13: // TWCC_CAPUNSUPPORTED
            case 14: // TWCC_CAPBADOPERATION
                return Unsupported("these settings");
            case 16: // TWCC_DENIED
                return new(ErrorCodes.Blocked, "The scanner's driver denied access.");
            case 5: // TWCC_OPERATIONERROR: the driver has already shown its own message
                return new(ErrorCodes.Failed, "The scanner reported an error.");
            default:
                return new(ErrorCodes.Failed, $"The scanner reported an error (TWAIN condition {conditionCode}).");
        }
    }

    /// <summary>Anything else that can go wrong, as a protocol error</summary>
    public static ScanException From(Exception e)
    {
        switch (e)
        {
            case ScanException se:
                return se;
            case COMException com:
                return FromHResult(unchecked((uint)com.HResult));
            case UnauthorizedAccessException:
                return new(ErrorCodes.Blocked, "Access was denied: " + e.Message, e);
            case TimeoutException:
                return new(ErrorCodes.Offline, "The scanner stopped responding.", e);
            default:
                return new(ErrorCodes.Failed, string.IsNullOrEmpty(e.Message) ? e.GetType().Name : e.Message, e);
        }
    }
}
