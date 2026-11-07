// Windows API declarations the certificate helper uses (crypt32, ncrypt,
// advapi32). Only what's needed: finding a certificate's key provider without
// opening the key, and signing a digest with the key.
using System;
using System.Runtime.InteropServices;

namespace Paperwing.Certs
{
    static class Native
    {
        public const uint CERT_KEY_PROV_INFO_PROP_ID = 2;
        public const uint CERT_NCRYPT_KEY_SPEC = 0xFFFFFFFF;

        public const uint CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG = 0x80;
        public const uint CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG = 0x20000;

        public const uint CRYPT_VERIFYCONTEXT = 0xF0000000;
        public const uint CRYPT_SILENT = 0x40;
        public const uint CRYPT_MACHINE_KEYSET = 0x20;
        public const uint PROV_RSA_AES = 24;
        public const uint PP_IMPTYPE = 3;
        public const uint CRYPT_IMPL_HARDWARE = 1;
        public const uint CRYPT_IMPL_REMOVABLE = 8;
        public const uint HP_HASHVAL = 2;
        public const uint CALG_SHA_256 = 0x800c;
        public const uint CALG_SHA_384 = 0x800d;
        public const string MS_ENH_RSA_AES_PROV = "Microsoft Enhanced RSA and AES Cryptographic Provider";

        public const uint BCRYPT_PAD_PKCS1 = 0x2;
        public const uint NCRYPT_IMPL_HARDWARE_FLAG = 0x1;
        public const uint NCRYPT_IMPL_REMOVABLE_FLAG = 0x8;
        public const string NCRYPT_WINDOW_HANDLE_PROPERTY = "HWND Handle";
        public const string NCRYPT_USE_CONTEXT_PROPERTY = "Use Context";
        public const string NCRYPT_IMPL_TYPE_PROPERTY = "Impl Type";

        public const int NTE_BAD_ALGID = unchecked((int)0x80090008);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct CRYPT_KEY_PROV_INFO
        {
            public string pwszContainerName;
            public string pwszProvName;
            public uint dwProvType;
            public uint dwFlags;
            public uint cProvParam;
            public IntPtr rgProvParam;
            public uint dwKeySpec;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BCRYPT_PKCS1_PADDING_INFO
        {
            public IntPtr pszAlgId;
        }

        [DllImport("crypt32.dll", SetLastError = true)]
        public static extern bool CertGetCertificateContextProperty(
            IntPtr pCertContext, uint dwPropId, IntPtr pvData, ref uint pcbData);

        [DllImport("crypt32.dll", SetLastError = true)]
        public static extern bool CryptAcquireCertificatePrivateKey(
            IntPtr pCert, uint dwFlags, IntPtr pvParameters,
            out IntPtr phCryptProvOrNCryptKey, out uint pdwKeySpec,
            [MarshalAs(UnmanagedType.Bool)] out bool pfCallerFreeProvOrNCryptKey);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        public static extern int NCryptSignHash(
            IntPtr hKey, IntPtr pPaddingInfo, byte[] pbHashValue, int cbHashValue,
            byte[] pbSignature, int cbSignature, out int pcbResult, uint dwFlags);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        public static extern int NCryptSetProperty(
            IntPtr hObject, string pszProperty, IntPtr pbInput, int cbInput, uint dwFlags);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        public static extern int NCryptSetProperty(
            IntPtr hObject, string pszProperty, byte[] pbInput, int cbInput, uint dwFlags);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        public static extern int NCryptOpenStorageProvider(
            out IntPtr phProvider, string pszProviderName, uint dwFlags);

        [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
        public static extern int NCryptGetProperty(
            IntPtr hObject, string pszProperty, out uint pbOutput, int cbOutput,
            out int pcbResult, uint dwFlags);

        [DllImport("ncrypt.dll")]
        public static extern int NCryptFreeObject(IntPtr hObject);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CryptAcquireContext(
            out IntPtr phProv, string pszContainer, string pszProvider, uint dwProvType, uint dwFlags);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CryptGetProvParam(
            IntPtr hProv, uint dwParam, out uint pbData, ref uint pdwDataLen, uint dwFlags);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CryptReleaseContext(IntPtr hProv, uint dwFlags);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CryptCreateHash(
            IntPtr hProv, uint algid, IntPtr hKey, uint dwFlags, out IntPtr phHash);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CryptSetHashParam(IntPtr hHash, uint dwParam, byte[] pbData, uint dwFlags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CryptSignHash(
            IntPtr hHash, uint dwKeySpec, string szDescription, uint dwFlags,
            byte[] pbSignature, ref int pdwSigLen);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CryptDestroyHash(IntPtr hHash);

        /// <summary>The last Win32 error as an HRESULT (CryptoAPI reports
        /// both kinds through GetLastError)</summary>
        public static int LastError()
        {
            var e = Marshal.GetLastWin32Error();
            if (e > 0 && e <= 0xFFFF) return unchecked((int)(0x80070000 | (uint)e));
            return e;
        }
    }
}
