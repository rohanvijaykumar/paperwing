// Paperwing's certificate helper for Windows: the parts with no Windows API
// calls (JSON output, signature encoding, error mapping, arguments), kept
// apart so the test runner (tests/) can check them on any machine.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Paperwing.Certs
{
    public static class Json
    {
        /// <summary>A JSON string literal (quotes included)</summary>
        public static string Str(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (var c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029)
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Bool(bool b) => b ? "true" : "false";

        public static string Num(int n) => n.ToString(CultureInfo.InvariantCulture);

        /// <summary>{"a":…,"b":…} from already-encoded values, in order</summary>
        public static string Obj(params KeyValuePair<string, string>[] fields)
        {
            var sb = new StringBuilder("{");
            for (var i = 0; i < fields.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Str(fields[i].Key)).Append(':').Append(fields[i].Value);
            }
            return sb.Append('}').ToString();
        }

        public static string Arr(IEnumerable<string> encoded)
        {
            return "[" + string.Join(",", encoded) + "]";
        }

        public static KeyValuePair<string, string> F(string key, string encoded)
        {
            return new KeyValuePair<string, string>(key, encoded);
        }
    }

    public static class Der
    {
        /// <summary>
        /// An ECDSA signature as Windows (CNG) returns it, r and s side by
        /// side (IEEE P1363), into the DER SEQUENCE { INTEGER r, INTEGER s }
        /// that CMS and PDF signatures carry.
        /// </summary>
        public static byte[] EcdsaP1363ToDer(byte[] p1363)
        {
            if (p1363 == null || p1363.Length == 0 || p1363.Length % 2 != 0)
                throw new ArgumentException("not an r||s signature");
            var half = p1363.Length / 2;
            var r = Integer(p1363, 0, half);
            var s = Integer(p1363, half, half);
            var body = new byte[r.Length + s.Length];
            Buffer.BlockCopy(r, 0, body, 0, r.Length);
            Buffer.BlockCopy(s, 0, body, r.Length, s.Length);
            return Tlv(0x30, body);
        }

        /// <summary>A positive big-endian number as a minimal DER INTEGER</summary>
        static byte[] Integer(byte[] src, int offset, int length)
        {
            var start = offset;
            var end = offset + length;
            while (start < end - 1 && src[start] == 0) start++;
            var pad = (src[start] & 0x80) != 0 ? 1 : 0;
            var value = new byte[end - start + pad];
            Buffer.BlockCopy(src, start, value, pad, end - start);
            return Tlv(0x02, value);
        }

        public static byte[] Tlv(byte tag, byte[] value)
        {
            byte[] len;
            if (value.Length < 0x80) len = new[] { (byte)value.Length };
            else if (value.Length <= 0xff) len = new byte[] { 0x81, (byte)value.Length };
            else len = new byte[] { 0x82, (byte)(value.Length >> 8), (byte)value.Length };
            var outp = new byte[1 + len.Length + value.Length];
            outp[0] = tag;
            Buffer.BlockCopy(len, 0, outp, 1, len.Length);
            Buffer.BlockCopy(value, 0, outp, 1 + len.Length, value.Length);
            return outp;
        }
    }

    /// <summary>
    /// Windows' error codes from signing (smart card, CNG and CryptoAPI) as
    /// the few cases Paperwing tells apart in plain words
    /// </summary>
    public static class Errors
    {
        public const string Cancelled = "cancelled";
        public const string WrongPin = "wrong-pin";
        public const string PinBlocked = "pin-blocked";
        public const string CardRemoved = "card-removed";
        public const string KeyUnusable = "key-unusable";
        public const string Failed = "failed";

        public static string Map(int hresult)
        {
            switch (unchecked((uint)hresult))
            {
                case 0x8010006E: // SCARD_W_CANCELLED_BY_USER
                case 0x80100002: // SCARD_E_CANCELLED
                case 0x800704C7: // HRESULT_FROM_WIN32(ERROR_CANCELLED)
                case 0x000004C7: // ERROR_CANCELLED as a plain Win32 code
                    return Cancelled;
                case 0x8010006B: // SCARD_W_WRONG_CHV
                case 0x8010002A: // SCARD_E_INVALID_CHV
                    return WrongPin;
                case 0x8010006C: // SCARD_W_CHV_BLOCKED
                    return PinBlocked;
                case 0x80100069: // SCARD_W_REMOVED_CARD
                case 0x8010000C: // SCARD_E_NO_SMARTCARD
                case 0x8010002E: // SCARD_E_NO_READERS_AVAILABLE
                case 0x80100017: // SCARD_E_READER_UNAVAILABLE
                case 0x80100068: // SCARD_W_RESET_CARD
                    return CardRemoved;
                case 0x80090010: // NTE_PERM
                case 0x80090016: // NTE_BAD_KEYSET
                case 0x8009000D: // NTE_NO_KEY
                case 0x80090003: // NTE_BAD_KEY
                case 0x80090009: // NTE_BAD_FLAGS
                case 0x80090008: // NTE_BAD_ALGID
                case 0x80090029: // NTE_NOT_SUPPORTED
                case 0x80090027: // NTE_INVALID_PARAMETER
                case 0x80090014: // NTE_BAD_PROV_TYPE
                case 0x80090019: // NTE_PROV_TYPE_NOT_DEF
                case 0x8009001F: // NTE_PROV_DLL_NOT_FOUND
                case 0x80090022: // NTE_SILENT_CONTEXT
                case 0x8009200B: // CRYPT_E_NO_KEY_PROPERTY
                case 0x80092004: // CRYPT_E_NOT_FOUND
                case 0x80070005: // E_ACCESSDENIED
                    return KeyUnusable;
                default:
                    return Failed;
            }
        }
    }

    public static class Algorithms
    {
        public const string RsaOid = "1.2.840.113549.1.1.1";
        public const string EcOid = "1.2.840.10045.2.1";

        /// <summary>Named curve OID → "P-256" etc. (null if not one Paperwing signs with)</summary>
        public static string Curve(string oid)
        {
            switch (oid)
            {
                case "1.2.840.10045.3.1.7": return "P-256";
                case "1.3.132.0.34": return "P-384";
                case "1.3.132.0.35": return "P-521";
                default: return null;
            }
        }

        public static int CurveBits(string curve)
        {
            switch (curve)
            {
                case "P-256": return 256;
                case "P-384": return 384;
                case "P-521": return 521;
                default: return 0;
            }
        }

        /// <summary>The digest length each -Alg needs</summary>
        public static int HashLength(string alg)
        {
            switch (alg)
            {
                case "sha256": return 32;
                case "sha384": return 48;
                default: return 0;
            }
        }
    }

    /// <summary>Where a key lives, from its provider (no key is opened)</summary>
    public static class Sources
    {
        public const string Store = "windows-store";
        public const string SmartCard = "smart-card";
        public const string Token = "token";

        /// <param name="provider">The key's provider (CSP or KSP) name</param>
        /// <param name="hardware">The provider says its keys are on hardware
        /// or removable (null: it couldn't be asked)</param>
        public static string Classify(string provider, bool? hardware)
        {
            var name = provider ?? "";
            var smartCardName = name.IndexOf("smart card", StringComparison.OrdinalIgnoreCase) >= 0
                || name.IndexOf("smartcard", StringComparison.OrdinalIgnoreCase) >= 0;
            if (smartCardName) return SmartCard;
            if (hardware == true) return Token;
            return Store;
        }
    }

    /// <summary>The command line: a command, then -Name value pairs</summary>
    public sealed class Args
    {
        public readonly string Command;
        readonly Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public Args(string[] argv)
        {
            Command = argv.Length > 0 ? argv[0] : "";
            for (var i = 1; i + 1 < argv.Length; i += 2)
            {
                if (!argv[i].StartsWith("-", StringComparison.Ordinal))
                    throw new ArgumentException("expected -Name value pairs");
                values[argv[i].TrimStart('-')] = argv[i + 1];
            }
            if (argv.Length > 1 && argv.Length % 2 == 0)
                throw new ArgumentException("an option has no value");
        }

        public string Get(string name)
        {
            string v;
            return values.TryGetValue(name, out v) ? v : null;
        }
    }

    /// <summary>
    /// Certificate ids: "cu:" (current user) or "lm:" (computer) and the
    /// SHA-1 thumbprint, the way Windows itself finds a certificate
    /// </summary>
    public static class Ids
    {
        public static string Make(bool machine, string thumbprint)
        {
            return (machine ? "lm:" : "cu:") + thumbprint.ToUpperInvariant();
        }

        public static bool TryParse(string id, out bool machine, out string thumbprint)
        {
            machine = false;
            thumbprint = null;
            if (string.IsNullOrEmpty(id) || id.Length != 43) return false;
            var prefix = id.Substring(0, 3);
            if (prefix != "cu:" && prefix != "lm:") return false;
            var tp = id.Substring(3);
            foreach (var c in tp)
                if (!Uri.IsHexDigit(c)) return false;
            machine = prefix == "lm:";
            thumbprint = tp.ToUpperInvariant();
            return true;
        }
    }
}
