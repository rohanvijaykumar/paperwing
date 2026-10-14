// Test for PaperwingThumbnails.dll: loads it the way Explorer does (through
// its class factory, with a file stream) and checks the thumbnail it draws.
//
//   test-thumbnail.exe <PaperwingThumbnails.dll> <good.pdf> <protected.pdf> <out.bmp>
//
// Exit code 0 when a good PDF gives a non-blank thumbnail and a protected or
// broken file fails cleanly.

#include <windows.h>
#include <shlwapi.h>
#include <thumbcache.h>

#include <cstdio>
#include <initializer_list>

static const CLSID CLSID_PaperwingThumbnails = {
    0x4eb59494, 0xe569, 0x4edf, {0xb7, 0x7f, 0x06, 0xce, 0xdd, 0xc4, 0x5e, 0xe2}};

typedef HRESULT(STDAPICALLTYPE* GetClassObjectFn)(REFCLSID, REFIID, void**);

struct Result {
  HRESULT hr = E_FAIL;
  HBITMAP bitmap = nullptr;
};

static Result Thumbnail(GetClassObjectFn getClassObject, IStream* stream, UINT size) {
  Result r;
  IClassFactory* factory = nullptr;
  r.hr = getClassObject(CLSID_PaperwingThumbnails, IID_PPV_ARGS(&factory));
  if (FAILED(r.hr)) return r;
  IInitializeWithStream* init = nullptr;
  r.hr = factory->CreateInstance(nullptr, IID_PPV_ARGS(&init));
  factory->Release();
  if (FAILED(r.hr)) return r;
  r.hr = init->Initialize(stream, STGM_READ);
  if (SUCCEEDED(r.hr)) {
    IThumbnailProvider* provider = nullptr;
    r.hr = init->QueryInterface(IID_PPV_ARGS(&provider));
    if (SUCCEEDED(r.hr)) {
      WTS_ALPHATYPE alpha;
      r.hr = provider->GetThumbnail(size, &r.bitmap, &alpha);
      provider->Release();
    }
  }
  init->Release();
  return r;
}

static Result ThumbnailOfFile(GetClassObjectFn fn, const wchar_t* path, UINT size) {
  IStream* stream = nullptr;
  Result r;
  r.hr = SHCreateStreamOnFileEx(path, STGM_READ | STGM_SHARE_DENY_NONE, 0, FALSE, nullptr, &stream);
  if (FAILED(r.hr)) return r;
  r = Thumbnail(fn, stream, size);
  stream->Release();
  return r;
}

static bool SaveBmp(HBITMAP bitmap, const wchar_t* path, int* width, int* height, double* inked) {
  BITMAP bm = {};
  if (!GetObjectW(bitmap, sizeof(bm), &bm) || bm.bmBitsPixel != 32 || !bm.bmBits) return false;
  *width = bm.bmWidth;
  *height = bm.bmHeight;
  const BYTE* px = static_cast<const BYTE*>(bm.bmBits);
  size_t dark = 0, total = static_cast<size_t>(bm.bmWidth) * bm.bmHeight;
  for (size_t i = 0; i < total; i++) {
    const BYTE* p = px + i * 4;
    if (p[0] + p[1] + p[2] < 600) dark++;  // clearly not white paper
  }
  *inked = total ? static_cast<double>(dark) / total : 0;

  BITMAPFILEHEADER file = {};
  BITMAPINFOHEADER info = {};
  info.biSize = sizeof(info);
  info.biWidth = bm.bmWidth;
  info.biHeight = -bm.bmHeight;
  info.biPlanes = 1;
  info.biBitCount = 32;
  info.biCompression = BI_RGB;
  DWORD bytes = static_cast<DWORD>(total * 4);
  file.bfType = 0x4D42;
  file.bfOffBits = sizeof(file) + sizeof(info);
  file.bfSize = file.bfOffBits + bytes;
  FILE* f = nullptr;
  if (_wfopen_s(&f, path, L"wb") || !f) return false;
  fwrite(&file, sizeof(file), 1, f);
  fwrite(&info, sizeof(info), 1, f);
  fwrite(px, 1, bytes, f);
  fclose(f);
  return true;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 5) {
    fwprintf(stderr, L"usage: test-thumbnail <dll> <good.pdf> <protected.pdf> <out.bmp>\n");
    return 2;
  }
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  HMODULE dll = LoadLibraryExW(argv[1], nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!dll) {
    fwprintf(stderr, L"FAIL: could not load %s (%lu)\n", argv[1], GetLastError());
    return 1;
  }
  auto getClassObject = reinterpret_cast<GetClassObjectFn>(GetProcAddress(dll, "DllGetClassObject"));
  if (!getClassObject) {
    fwprintf(stderr, L"FAIL: DllGetClassObject not exported\n");
    return 1;
  }
  int failures = 0;

  // 1. A normal PDF at two sizes
  for (UINT size : {256u, 96u}) {
    Result r = ThumbnailOfFile(getClassObject, argv[2], size);
    int w = 0, h = 0;
    double inked = 0;
    bool saved = SUCCEEDED(r.hr) && r.bitmap && SaveBmp(r.bitmap, argv[4], &w, &h, &inked);
    bool ok = saved && static_cast<UINT>(max(w, h)) == size && inked > 0.002;
    wprintf(L"%s good.pdf @%u: hr=0x%08lx %dx%d inked=%.2f%%\n", ok ? L"ok  " : L"FAIL", size,
            static_cast<unsigned long>(r.hr), w, h, inked * 100);
    if (!ok) failures++;
    if (r.bitmap) DeleteObject(r.bitmap);
  }

  // 2. A password-protected PDF: must fail, not crash or hang
  {
    Result r = ThumbnailOfFile(getClassObject, argv[3], 256);
    bool ok = FAILED(r.hr) && !r.bitmap;
    wprintf(L"%s protected.pdf: hr=0x%08lx\n", ok ? L"ok  " : L"FAIL", static_cast<unsigned long>(r.hr));
    if (!ok) failures++;
    if (r.bitmap) DeleteObject(r.bitmap);
  }

  // 3. Garbage bytes: must fail cleanly
  {
    static const char junk[] = "%PDF-1.7\nthis is not really a pdf\n%%EOF\n";
    IStream* stream = SHCreateMemStream(reinterpret_cast<const BYTE*>(junk), sizeof(junk));
    Result r = Thumbnail(getClassObject, stream, 256);
    stream->Release();
    bool ok = FAILED(r.hr) && !r.bitmap;
    wprintf(L"%s broken file: hr=0x%08lx\n", ok ? L"ok  " : L"FAIL", static_cast<unsigned long>(r.hr));
    if (!ok) failures++;
  }

  wprintf(failures ? L"%d check(s) failed\n" : L"all checks passed\n", failures);
  return failures ? 1 : 0;
}
