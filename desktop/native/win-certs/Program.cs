// paperwing-certs.exe: signs with certificates in the Windows certificate
// store, smart cards and USB tokens included (Windows lists their
// certificates in the store). Paperwing's main process runs one command per
// process and reads one JSON line from stdout:
//
//   list   → {"type":"certs","certs":[…]}  never opens a private key, so
//            listing never asks for a PIN
//   sign -Id <id> -Hash <base64 digest> -Alg sha256|sha384 -Window <HWND>
//          → {"type":"signature","sig":"<base64>"}  (RSA PKCS#1 v1.5, ECDSA
//            as DER). The key never leaves Windows: Windows (or the card)
//            signs the digest, asking for the PIN in front of Paperwing's
//            window if the key needs one.
//   roots  → {"type":"roots","certs":[…]}  the trusted root certificates
//            (Validate signatures can trust them)
//
// Errors: {"type":"error","code":…} with cancelled, wrong-pin, pin-blocked,
// card-removed, key-unusable or failed, and exit code 2.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Paperwing.Certs
{
    sealed class SignError : Exception
    {
        public readonly string Code;
        public readonly int HResult32;

        public SignError(string code, int hresult) : base(code)
        {
            Code = code;
            HResult32 = hresult;
        }
    }

    static class Program
    {
        static int Main(string[] argv)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                var args = new Args(argv);
                switch (args.Command)
                {
                    case "list":
                        Emit(List());
                        return 0;
                    case "sign":
                        Emit(Sign(args));
                        return 0;
                    case "roots":
                        Emit(Roots());
                        return 0;
                    default:
                        Console.Error.WriteLine("usage: paperwing-certs list | sign -Id <id> -Hash <base64> -Alg sha256|sha384 [-Window <hwnd>] | roots");
                        Emit(ErrorLine(Errors.Failed, 0));
                        return 2;
                }
            }
            catch (SignError e)
            {
                Emit(ErrorLine(e.Code, e.HResult32));
                return 2;
            }
            catch (CryptographicException e)
            {
                Emit(ErrorLine(Errors.Map(e.HResult), e.HResult));
                return 2;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.GetType().Name + ": " + e.Message);
                Emit(ErrorLine(Errors.Failed, e.HResult));
                return 2;
            }
        }

        static void Emit(string line)
        {
            Console.Out.Write(line + "\n");
            Console.Out.Flush();
        }

        static string ErrorLine(string code, int hresult)
        {
            return Json.Obj(
                Json.F("type", Json.Str("error")),
                Json.F("code", Json.Str(code)),
                Json.F("detail", Json.Str("0x" + unchecked((uint)hresult).ToString("X8"))));
        }

        /* ---------------------------------------------------------- */
        /* list                                                        */
        /* ---------------------------------------------------------- */

        static string List()
        {
            var items = new List<string>();
            var seen = new HashSet<string>();
            foreach (var machine in new[] { false, true })
            {
                X509Store store;
                try
                {
                    store = new X509Store(StoreName.My, machine ? StoreLocation.LocalMachine : StoreLocation.CurrentUser);
                    store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
                }
                catch (CryptographicException)
                {
                    continue; // (the computer's store isn't readable here)
                }
                try
                {
                    foreach (var cert in store.Certificates)
                    {
                        // The same certificate in both stores: the user's one
                        if (!seen.Add(cert.Thumbprint)) continue;
                        try
                        {
                            items.Add(Describe(cert, machine));
                        }
                        catch (Exception e)
                        {
                            Console.Error.WriteLine("skipped a certificate: " + e.Message);
                        }
                    }
                }
                finally
                {
                    store.Close();
                }
            }
            return Json.Obj(Json.F("type", Json.Str("certs")), Json.F("certs", Json.Arr(items)));
        }

        static string Describe(X509Certificate2 cert, bool machine)
        {
            var prov = KeyProvInfo(cert);
            var hasKey = prov.HasValue;
            var provider = hasKey ? prov.Value.pwszProvName ?? "" : "";
            var source = hasKey ? Sources.Classify(provider, IsHardware(prov.Value)) : Sources.Store;

            var keyOid = cert.PublicKey.Oid.Value;
            string keyAlg = null, curve = null;
            var bits = 0;
            if (keyOid == Algorithms.RsaOid)
            {
                keyAlg = "rsa";
                bits = RsaBits(cert);
            }
            else if (keyOid == Algorithms.EcOid)
            {
                keyAlg = "ec";
                curve = Algorithms.Curve(CurveOid(cert.PublicKey.EncodedParameters.RawData));
                bits = Algorithms.CurveBits(curve);
            }

            var chain = new List<string>();
            if (hasKey)
                foreach (var c in ChainOf(cert))
                    chain.Add(Json.Str(Convert.ToBase64String(c.RawData)));

            return Json.Obj(
                Json.F("id", Json.Str(Ids.Make(machine, cert.Thumbprint))),
                Json.F("source", Json.Str(source)),
                Json.F("provider", Json.Str(provider)),
                Json.F("certDer", Json.Str(Convert.ToBase64String(cert.RawData))),
                Json.F("chainDer", Json.Arr(chain)),
                Json.F("hasPrivateKey", Json.Bool(hasKey)),
                Json.F("keyAlg", keyAlg == null ? "null" : Json.Str(keyAlg)),
                Json.F("keyBits", Json.Num(bits)),
                Json.F("curve", curve == null ? "null" : Json.Str(curve)));
        }

        /// <summary>Which key the certificate goes with, if any: the property
        /// Windows keeps with it. Reading it opens nothing.</summary>
        static Native.CRYPT_KEY_PROV_INFO? KeyProvInfo(X509Certificate2 cert)
        {
            uint size = 0;
            if (!Native.CertGetCertificateContextProperty(cert.Handle, Native.CERT_KEY_PROV_INFO_PROP_ID, IntPtr.Zero, ref size) || size == 0)
                return null;
            var buf = Marshal.AllocHGlobal((int)size);
            try
            {
                if (!Native.CertGetCertificateContextProperty(cert.Handle, Native.CERT_KEY_PROV_INFO_PROP_ID, buf, ref size))
                    return null;
                return (Native.CRYPT_KEY_PROV_INFO)Marshal.PtrToStructure(buf, typeof(Native.CRYPT_KEY_PROV_INFO));
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        /// <summary>Does the key's provider keep keys on hardware (a card or
        /// token)? Asks the provider, not the key: no PIN, no card access.</summary>
        static bool? IsHardware(Native.CRYPT_KEY_PROV_INFO info)
        {
            var name = info.pwszProvName ?? "";
            if (name.StartsWith("Microsoft", StringComparison.Ordinal)
                && name.IndexOf("Smart Card", StringComparison.OrdinalIgnoreCase) < 0
                && name.IndexOf("Platform", StringComparison.OrdinalIgnoreCase) < 0)
                return false; // Windows' own software providers
            try
            {
                if (info.dwProvType == 0)
                {
                    IntPtr prov;
                    if (Native.NCryptOpenStorageProvider(out prov, name, 0) != 0) return null;
                    try
                    {
                        uint type;
                        int got;
                        if (Native.NCryptGetProperty(prov, Native.NCRYPT_IMPL_TYPE_PROPERTY, out type, 4, out got, 0) != 0) return null;
                        return (type & (Native.NCRYPT_IMPL_HARDWARE_FLAG | Native.NCRYPT_IMPL_REMOVABLE_FLAG)) != 0;
                    }
                    finally
                    {
                        Native.NCryptFreeObject(prov);
                    }
                }
                IntPtr hProv;
                if (!Native.CryptAcquireContext(out hProv, null, name, info.dwProvType, Native.CRYPT_VERIFYCONTEXT | Native.CRYPT_SILENT))
                    return null;
                try
                {
                    uint imp;
                    uint len = 4;
                    if (!Native.CryptGetProvParam(hProv, Native.PP_IMPTYPE, out imp, ref len, 0)) return null;
                    return (imp & (Native.CRYPT_IMPL_HARDWARE | Native.CRYPT_IMPL_REMOVABLE)) != 0;
                }
                finally
                {
                    Native.CryptReleaseContext(hProv, 0);
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        static int RsaBits(X509Certificate2 cert)
        {
            // RSAPublicKey ::= SEQUENCE { modulus INTEGER, … }
            var der = cert.PublicKey.EncodedKeyValue.RawData;
            var pos = 0;
            ReadHeader(der, ref pos); // SEQUENCE
            var len = ReadHeader(der, ref pos); // INTEGER
            var start = pos;
            while (len > 0 && der[start] == 0)
            {
                start++;
                len--;
            }
            if (len <= 0) return 0;
            var top = der[start];
            var bits = (len - 1) * 8;
            while (top != 0)
            {
                bits++;
                top >>= 1;
            }
            return bits;
        }

        static string CurveOid(byte[] parameters)
        {
            // namedCurve OBJECT IDENTIFIER
            if (parameters == null || parameters.Length < 2 || parameters[0] != 0x06) return null;
            var pos = 0;
            var len = ReadHeader(parameters, ref pos);
            var sb = new StringBuilder();
            long value = 0;
            for (var i = 0; i < len; i++)
            {
                var b = parameters[pos + i];
                value = (value << 7) | (uint)(b & 0x7f);
                if ((b & 0x80) != 0) continue;
                if (sb.Length == 0)
                {
                    var first = value < 80 ? value / 40 : 2;
                    sb.Append(first).Append('.').Append(value - first * 40);
                }
                else
                {
                    sb.Append('.').Append(value);
                }
                value = 0;
            }
            return sb.ToString();
        }

        /// <summary>Skips a DER tag and length; returns the length</summary>
        static int ReadHeader(byte[] der, ref int pos)
        {
            pos++; // tag
            int len = der[pos++];
            if ((len & 0x80) == 0) return len;
            var n = len & 0x7f;
            len = 0;
            for (var i = 0; i < n; i++) len = (len << 8) | der[pos++];
            return len;
        }

        /// <summary>The issuers up to the root, as Windows finds them in its
        /// stores (revocation isn't checked here)</summary>
        static IEnumerable<X509Certificate2> ChainOf(X509Certificate2 cert)
        {
            var result = new List<X509Certificate2>();
            using (var chain = new X509Chain())
            {
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                chain.ChainPolicy.VerificationFlags = X509VerificationFlags.AllFlags;
                // A missing issuer may be fetched from the address in the
                // certificate; don't hold up the list for it
                chain.ChainPolicy.UrlRetrievalTimeout = TimeSpan.FromSeconds(2);
                try
                {
                    chain.Build(cert);
                }
                catch (CryptographicException)
                {
                    return result;
                }
                for (var i = 1; i < chain.ChainElements.Count; i++)
                    result.Add(chain.ChainElements[i].Certificate);
            }
            return result;
        }

        /* ---------------------------------------------------------- */
        /* sign                                                        */
        /* ---------------------------------------------------------- */

        static string Sign(Args args)
        {
            bool machine;
            string thumbprint;
            if (!Ids.TryParse(args.Get("Id"), out machine, out thumbprint))
                throw new SignError(Errors.Failed, 0);
            var alg = args.Get("Alg") ?? "sha256";
            var hashLength = Algorithms.HashLength(alg);
            byte[] hash;
            try
            {
                hash = Convert.FromBase64String(args.Get("Hash") ?? "");
            }
            catch (FormatException)
            {
                throw new SignError(Errors.Failed, 0);
            }
            if (hashLength == 0 || hash.Length != hashLength) throw new SignError(Errors.Failed, 0);
            var hwnd = ParseWindow(args.Get("Window"));

            var store = new X509Store(StoreName.My, machine ? StoreLocation.LocalMachine : StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
            X509Certificate2 cert;
            try
            {
                var found = store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false);
                if (found.Count == 0) throw new SignError(Errors.KeyUnusable, unchecked((int)0x80092004));
                cert = found[0];
            }
            finally
            {
                store.Close();
            }

            var keyOid = cert.PublicKey.Oid.Value;
            if (keyOid != Algorithms.RsaOid && keyOid != Algorithms.EcOid)
                throw new SignError(Errors.KeyUnusable, Native.NTE_BAD_ALGID);
            var isEc = keyOid == Algorithms.EcOid;

            var sig = SignDigest(cert, hash, alg, isEc, hwnd);
            return Json.Obj(Json.F("type", Json.Str("signature")), Json.F("sig", Json.Str(Convert.ToBase64String(sig))));
        }

        static IntPtr ParseWindow(string value)
        {
            if (string.IsNullOrEmpty(value)) return IntPtr.Zero;
            ulong n;
            if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? ulong.TryParse(value.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out n)
                : ulong.TryParse(value, out n))
                return new IntPtr(unchecked((long)n));
            return IntPtr.Zero;
        }

        static byte[] SignDigest(X509Certificate2 cert, byte[] hash, string alg, bool isEc, IntPtr hwnd)
        {
            // CNG first: since October 2025 Windows gives smart cards' RSA
            // keys to the smart card key storage provider too
            var flags = Native.CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG;
            var hwndBox = IntPtr.Zero;
            if (hwnd != IntPtr.Zero)
            {
                flags |= Native.CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG;
                hwndBox = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(hwndBox, hwnd);
            }
            IntPtr key;
            uint keySpec;
            bool mustFree;
            try
            {
                if (!Native.CryptAcquireCertificatePrivateKey(cert.Handle, flags, hwndBox, out key, out keySpec, out mustFree))
                {
                    var err = Native.LastError();
                    throw new SignError(Errors.Map(err), err);
                }
            }
            finally
            {
                if (hwndBox != IntPtr.Zero) Marshal.FreeHGlobal(hwndBox);
            }

            if (keySpec == Native.CERT_NCRYPT_KEY_SPEC)
            {
                try
                {
                    return SignCng(key, hash, alg, isEc, hwnd);
                }
                finally
                {
                    if (mustFree) Native.NCryptFreeObject(key);
                }
            }
            try
            {
                if (isEc) throw new SignError(Errors.KeyUnusable, Native.NTE_BAD_ALGID);
                return SignCapi(cert, key, keySpec, hash, alg);
            }
            finally
            {
                if (mustFree) Native.CryptReleaseContext(key, 0);
            }
        }

        static byte[] SignCng(IntPtr key, byte[] hash, string alg, bool isEc, IntPtr hwnd)
        {
            if (hwnd != IntPtr.Zero)
            {
                var box = Marshal.AllocHGlobal(IntPtr.Size);
                try
                {
                    Marshal.WriteIntPtr(box, hwnd);
                    Native.NCryptSetProperty(key, Native.NCRYPT_WINDOW_HANDLE_PROPERTY, box, IntPtr.Size, 0);
                }
                finally
                {
                    Marshal.FreeHGlobal(box);
                }
            }
            // Shown in Windows' PIN dialog, so it's clear what the PIN is for
            var context = Encoding.Unicode.GetBytes("Sign a PDF document in Paperwing\0");
            Native.NCryptSetProperty(key, Native.NCRYPT_USE_CONTEXT_PROPERTY, context, context.Length, 0);

            var padding = IntPtr.Zero;
            var algName = IntPtr.Zero;
            uint padFlags = 0;
            try
            {
                if (!isEc)
                {
                    algName = Marshal.StringToHGlobalUni(alg == "sha384" ? "SHA384" : "SHA256");
                    padding = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.StructureToPtr(new Native.BCRYPT_PKCS1_PADDING_INFO { pszAlgId = algName }, padding, false);
                    padFlags = Native.BCRYPT_PAD_PKCS1;
                }
                int size;
                var status = Native.NCryptSignHash(key, padding, hash, hash.Length, null, 0, out size, padFlags);
                if (status != 0) throw new SignError(Errors.Map(status), status);
                var sig = new byte[size];
                status = Native.NCryptSignHash(key, padding, hash, hash.Length, sig, sig.Length, out size, padFlags);
                if (status != 0) throw new SignError(Errors.Map(status), status);
                if (size != sig.Length) Array.Resize(ref sig, size);
                return isEc ? Der.EcdsaP1363ToDer(sig) : sig;
            }
            finally
            {
                if (padding != IntPtr.Zero) Marshal.FreeHGlobal(padding);
                if (algName != IntPtr.Zero) Marshal.FreeHGlobal(algName);
            }
        }

        /// <summary>Older CryptoAPI keys (CSPs): RSA only</summary>
        static byte[] SignCapi(X509Certificate2 cert, IntPtr prov, uint keySpec, byte[] hash, string alg)
        {
            var algId = alg == "sha384" ? Native.CALG_SHA_384 : Native.CALG_SHA_256;
            IntPtr hHash;
            if (Native.CryptCreateHash(prov, algId, IntPtr.Zero, 0, out hHash))
                return SignWithHash(hHash, keySpec, hash);
            var err = Native.LastError();
            if (err != Native.NTE_BAD_ALGID) throw new SignError(Errors.Map(err), err);

            // Keys made with Windows' oldest software providers: the same key
            // container, opened through the provider that knows SHA-256
            var info = KeyProvInfo(cert);
            if (!info.HasValue || !(info.Value.pwszProvName ?? "").StartsWith("Microsoft", StringComparison.Ordinal))
                throw new SignError(Errors.KeyUnusable, err);
            IntPtr aes;
            var flags = info.Value.dwFlags & Native.CRYPT_MACHINE_KEYSET;
            if (!Native.CryptAcquireContext(out aes, info.Value.pwszContainerName, Native.MS_ENH_RSA_AES_PROV, Native.PROV_RSA_AES, flags))
            {
                var e2 = Native.LastError();
                throw new SignError(Errors.Map(e2), e2);
            }
            try
            {
                if (!Native.CryptCreateHash(aes, algId, IntPtr.Zero, 0, out hHash))
                {
                    var e3 = Native.LastError();
                    throw new SignError(Errors.Map(e3), e3);
                }
                return SignWithHash(hHash, keySpec, hash);
            }
            finally
            {
                Native.CryptReleaseContext(aes, 0);
            }
        }

        static byte[] SignWithHash(IntPtr hHash, uint keySpec, byte[] hash)
        {
            try
            {
                if (!Native.CryptSetHashParam(hHash, Native.HP_HASHVAL, hash, 0))
                {
                    var e = Native.LastError();
                    throw new SignError(Errors.Map(e), e);
                }
                var len = 0;
                if (!Native.CryptSignHash(hHash, keySpec, null, 0, null, ref len))
                {
                    var e = Native.LastError();
                    throw new SignError(Errors.Map(e), e);
                }
                var sig = new byte[len];
                if (!Native.CryptSignHash(hHash, keySpec, null, 0, sig, ref len))
                {
                    var e = Native.LastError();
                    throw new SignError(Errors.Map(e), e);
                }
                if (len != sig.Length) Array.Resize(ref sig, len);
                // CryptoAPI writes the signature little-endian
                Array.Reverse(sig);
                return sig;
            }
            finally
            {
                Native.CryptDestroyHash(hHash);
            }
        }

        /* ---------------------------------------------------------- */
        /* roots                                                       */
        /* ---------------------------------------------------------- */

        static string Roots()
        {
            var items = new List<string>();
            var seen = new HashSet<string>();
            var stores = new[]
            {
                new KeyValuePair<StoreName, StoreLocation>(StoreName.Root, StoreLocation.CurrentUser),
                new KeyValuePair<StoreName, StoreLocation>(StoreName.Root, StoreLocation.LocalMachine),
                new KeyValuePair<StoreName, StoreLocation>(StoreName.AuthRoot, StoreLocation.LocalMachine),
            };
            foreach (var s in stores)
            {
                X509Store store;
                try
                {
                    store = new X509Store(s.Key, s.Value);
                    store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
                }
                catch (CryptographicException)
                {
                    continue;
                }
                try
                {
                    foreach (var cert in store.Certificates)
                        if (seen.Add(cert.Thumbprint))
                            items.Add(Json.Str(Convert.ToBase64String(cert.RawData)));
                }
                finally
                {
                    store.Close();
                }
            }
            return Json.Obj(Json.F("type", Json.Str("roots")), Json.F("certs", Json.Arr(items)));
        }
    }
}
