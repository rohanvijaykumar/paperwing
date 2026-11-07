// Unit tests for Core.cs: run by build.ps1 -Test (exit code 1 on a failure)
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using Paperwing.Certs;

static class Tests
{
    static int failed;
    static int passed;

    static void Check(bool ok, string what)
    {
        if (ok) passed++;
        else
        {
            failed++;
            Console.WriteLine("FAIL " + what);
        }
    }

    static void Equal<T>(T expected, T actual, string what)
    {
        Check(EqualityComparer<T>.Default.Equals(expected, actual), what + ": expected " + expected + ", got " + actual);
    }

    static byte[] Hex(string hex)
    {
        return Enumerable.Range(0, hex.Length / 2).Select(i => Convert.ToByte(hex.Substring(i * 2, 2), 16)).ToArray();
    }

    static string ToHex(byte[] b)
    {
        return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
    }

    static int Main()
    {
        JsonStrings();
        EcdsaDer();
        EcdsaDerVerifies();
        ErrorCodes();
        Curves();
        SourcesFromProviders();
        Arguments();
        CertificateIds();
        Console.WriteLine(passed + " passed, " + failed + " failed");
        return failed == 0 ? 0 : 1;
    }

    static void JsonStrings()
    {
        Equal("\"a\"", Json.Str("a"), "plain");
        Equal("\"q\\\"b\\\\s\"", Json.Str("q\"b\\s"), "quote and backslash");
        Equal("\"\\n\\r\\t\\u0001\"", Json.Str("\n\r\t\u0001"), "control characters");
        Equal("\"Česká pošta\"", Json.Str("Česká pošta"), "non-ASCII stays as is (UTF-8 output)");
        Equal("\"\\u2028\"", Json.Str("\u2028"), "line separator escaped");
        Equal("null", Json.Str(null), "null");
        Equal("{\"a\":1,\"b\":true}", Json.Obj(Json.F("a", Json.Num(1)), Json.F("b", Json.Bool(true))), "object");
        Equal("[\"x\",\"y\"]", Json.Arr(new[] { Json.Str("x"), Json.Str("y") }), "array");
    }

    static void EcdsaDer()
    {
        // r and s without leading zeros or a high bit
        var p1363 = Hex("01020304" + "05060708");
        Equal("300c020401020304020405060708", ToHex(Der.EcdsaP1363ToDer(p1363)), "simple r, s");
        // High bit set: a 00 in front keeps the INTEGER positive
        Equal("300e" + "02050080000001" + "020500ff000001",
            ToHex(Der.EcdsaP1363ToDer(Hex("80000001" + "ff000001"))), "high bit gets a zero byte");
        // Leading zeros are dropped (minimal encoding)
        Equal("3006020101020102", ToHex(Der.EcdsaP1363ToDer(Hex("00000001" + "00000002"))), "leading zeros dropped");
        // All zero stays one zero byte
        Equal("3006020100020100", ToHex(Der.EcdsaP1363ToDer(Hex("0000" + "0000"))), "zero");
        // P-521: 66-byte halves, so the SEQUENCE needs a long length
        var big = new byte[132];
        for (var i = 0; i < big.Length; i++) big[i] = 0xff;
        var der = Der.EcdsaP1363ToDer(big);
        Equal((byte)0x30, der[0], "P-521 sequence tag");
        Equal((byte)0x81, der[1], "P-521 long length form");
        Equal(der.Length - 3, (int)der[2], "P-521 length");
        var threw = false;
        try { Der.EcdsaP1363ToDer(new byte[3]); } catch (ArgumentException) { threw = true; }
        Check(threw, "odd length is refused");
    }

    /// <summary>A real ECDSA signature, converted, is what a DER verifier accepts</summary>
    static void EcdsaDerVerifies()
    {
        foreach (var curve in new[] { ECCurve.NamedCurves.nistP256, ECCurve.NamedCurves.nistP384, ECCurve.NamedCurves.nistP521 })
        {
            using (var ec = ECDsa.Create(curve))
            {
                var hash = new byte[32];
                new Random(1).NextBytes(hash);
                for (var round = 0; round < 20; round++)
                {
                    hash[0] = (byte)round;
                    var p1363 = ec.SignHash(hash);
                    var der = Der.EcdsaP1363ToDer(p1363);
                    // Back from DER to r||s, by hand, and verify
                    var back = DerToP1363(der, p1363.Length / 2);
                    Check(ec.VerifyHash(hash, back), "round trip verifies (" + curve.Oid.FriendlyName + ")");
                }
            }
        }
    }

    static byte[] DerToP1363(byte[] der, int half)
    {
        var pos = 0;
        Read(der, ref pos);
        var r = ReadInt(der, ref pos);
        var s = ReadInt(der, ref pos);
        var outp = new byte[half * 2];
        Buffer.BlockCopy(r, 0, outp, half - r.Length, r.Length);
        Buffer.BlockCopy(s, 0, outp, 2 * half - s.Length, s.Length);
        return outp;
    }

    static int Read(byte[] der, ref int pos)
    {
        pos++;
        int len = der[pos++];
        if ((len & 0x80) == 0) return len;
        var n = len & 0x7f;
        len = 0;
        for (var i = 0; i < n; i++) len = (len << 8) | der[pos++];
        return len;
    }

    static byte[] ReadInt(byte[] der, ref int pos)
    {
        var len = Read(der, ref pos);
        var start = pos;
        pos += len;
        while (len > 1 && der[start] == 0)
        {
            start++;
            len--;
        }
        var v = new byte[len];
        Buffer.BlockCopy(der, start, v, 0, len);
        return v;
    }

    static void ErrorCodes()
    {
        Equal(Errors.Cancelled, Errors.Map(unchecked((int)0x8010006E)), "SCARD_W_CANCELLED_BY_USER");
        Equal(Errors.Cancelled, Errors.Map(unchecked((int)0x800704C7)), "ERROR_CANCELLED");
        Equal(Errors.WrongPin, Errors.Map(unchecked((int)0x8010006B)), "SCARD_W_WRONG_CHV");
        Equal(Errors.WrongPin, Errors.Map(unchecked((int)0x8010002A)), "SCARD_E_INVALID_CHV");
        Equal(Errors.PinBlocked, Errors.Map(unchecked((int)0x8010006C)), "SCARD_W_CHV_BLOCKED");
        Equal(Errors.CardRemoved, Errors.Map(unchecked((int)0x80100069)), "SCARD_W_REMOVED_CARD");
        Equal(Errors.CardRemoved, Errors.Map(unchecked((int)0x8010000C)), "SCARD_E_NO_SMARTCARD");
        Equal(Errors.KeyUnusable, Errors.Map(unchecked((int)0x80090010)), "NTE_PERM");
        Equal(Errors.KeyUnusable, Errors.Map(unchecked((int)0x8009200B)), "CRYPT_E_NO_KEY_PROPERTY");
        Equal(Errors.KeyUnusable, Errors.Map(unchecked((int)0x80090016)), "NTE_BAD_KEYSET");
        Equal(Errors.Failed, Errors.Map(unchecked((int)0x80004005)), "E_FAIL");
        Equal(Errors.Failed, Errors.Map(0), "zero");
    }

    static void Curves()
    {
        Equal("P-256", Algorithms.Curve("1.2.840.10045.3.1.7"), "P-256");
        Equal("P-384", Algorithms.Curve("1.3.132.0.34"), "P-384");
        Equal("P-521", Algorithms.Curve("1.3.132.0.35"), "P-521");
        Equal(null, Algorithms.Curve("1.3.36.3.3.2.8.1.1.7"), "brainpool isn't one");
        Equal(32, Algorithms.HashLength("sha256"), "sha256 length");
        Equal(48, Algorithms.HashLength("sha384"), "sha384 length");
        Equal(0, Algorithms.HashLength("md5"), "unknown");
    }

    static void SourcesFromProviders()
    {
        Equal(Sources.SmartCard, Sources.Classify("Microsoft Smart Card Key Storage Provider", null), "Microsoft smart card KSP");
        Equal(Sources.SmartCard, Sources.Classify("Microsoft Base Smart Card Crypto Provider", true), "Microsoft smart card CSP");
        Equal(Sources.SmartCard, Sources.Classify("SafeNet Smart Card Key Storage Provider", true), "vendor smart card KSP");
        Equal(Sources.Token, Sources.Classify("eToken Base Cryptographic Provider", true), "a USB token");
        Equal(Sources.Store, Sources.Classify("Microsoft Software Key Storage Provider", false), "software KSP");
        Equal(Sources.Store, Sources.Classify("Microsoft Enhanced RSA and AES Cryptographic Provider", false), "software CSP");
        Equal(Sources.Store, Sources.Classify("Some Vendor KSP", null), "unknown provider");
    }

    static void Arguments()
    {
        var a = new Args(new[] { "sign", "-Id", "cu:AB", "-hash", "xyz=" });
        Equal("sign", a.Command, "command");
        Equal("cu:AB", a.Get("Id"), "Id");
        Equal("xyz=", a.Get("Hash"), "names ignore case");
        Equal(null, a.Get("Window"), "absent");
        var threw = false;
        try { new Args(new[] { "sign", "-Id" }); } catch (ArgumentException) { threw = true; }
        Check(threw, "an option without a value is refused");
        threw = false;
        try { new Args(new[] { "sign", "Id", "x" }); } catch (ArgumentException) { threw = true; }
        Check(threw, "a value without a name is refused");
        Equal("", new Args(new string[0]).Command, "no command");
    }

    static void CertificateIds()
    {
        var tp = "0123456789abcdef0123456789ABCDEF01234567";
        var id = Ids.Make(false, tp);
        Equal("cu:" + tp.ToUpperInvariant(), id, "user id");
        bool machine;
        string parsed;
        Check(Ids.TryParse(id, out machine, out parsed) && !machine && parsed == tp.ToUpperInvariant(), "parses back");
        Check(Ids.TryParse(Ids.Make(true, tp), out machine, out parsed) && machine, "computer id");
        Check(!Ids.TryParse("xx:" + tp, out machine, out parsed), "unknown prefix");
        Check(!Ids.TryParse("cu:" + tp.Substring(1), out machine, out parsed), "short thumbprint");
        Check(!Ids.TryParse("cu:" + tp.Substring(1) + "g", out machine, out parsed), "not hex");
        Check(!Ids.TryParse(null, out machine, out parsed), "null");
    }
}
