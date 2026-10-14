// Paperwing PDF thumbnails for Windows File Explorer.
//
// A shell thumbnail provider (IThumbnailProvider + IInitializeWithStream)
// that draws the first page of a PDF with PDFium. The installer registers it
// for Paperwing's PDF file type only, so Explorer uses it while Paperwing is
// the default PDF app. Explorer runs stream-based providers in an isolated
// surrogate process, so a bad file can't take Explorer down.
//
// pdfium.dll (https://github.com/bblanchon/pdfium-binaries) sits next to this
// DLL and is loaded from there explicitly, never from the search path.

#include <windows.h>
#include <shlwapi.h>
#include <thumbcache.h>

#include <algorithm>
#include <cmath>
#include <new>
#include <vector>

// {4EB59494-E569-4EDF-B77F-06CEDDC45EE2}
static const CLSID CLSID_PaperwingThumbnails = {
    0x4eb59494, 0xe569, 0x4edf, {0xb7, 0x7f, 0x06, 0xce, 0xdd, 0xc4, 0x5e, 0xe2}};

static HMODULE g_module = nullptr;
static long g_locks = 0;  // live objects + IClassFactory::LockServer

// Larger files are skipped (Explorer shows the file type icon instead)
static const ULONGLONG kMaxBytes = 512ull * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* PDFium, loaded on first use                                          */
/* ------------------------------------------------------------------ */

typedef void* FPDF_DOCUMENT;
typedef void* FPDF_PAGE;
typedef void* FPDF_BITMAP;

static const int kBitmapBGRA = 4;  // FPDFBitmap_BGRA
static const int kRenderAnnotations = 0x01;  // FPDF_ANNOT

static struct {
  void(__stdcall* InitLibrary)();
  FPDF_DOCUMENT(__stdcall* LoadMemDocument64)(const void*, size_t, const char*);
  int(__stdcall* GetPageCount)(FPDF_DOCUMENT);
  FPDF_PAGE(__stdcall* LoadPage)(FPDF_DOCUMENT, int);
  float(__stdcall* GetPageWidthF)(FPDF_PAGE);
  float(__stdcall* GetPageHeightF)(FPDF_PAGE);
  FPDF_BITMAP(__stdcall* BitmapCreateEx)(int, int, int, void*, int);
  int(__stdcall* BitmapFillRect)(FPDF_BITMAP, int, int, int, int, unsigned long);
  void(__stdcall* RenderPageBitmap)(FPDF_BITMAP, FPDF_PAGE, int, int, int, int, int, int);
  void(__stdcall* BitmapDestroy)(FPDF_BITMAP);
  void(__stdcall* ClosePage)(FPDF_PAGE);
  void(__stdcall* CloseDocument)(FPDF_DOCUMENT);
} pdfium;

// PDFium isn't thread-safe; Explorer may call several providers at once
static SRWLOCK g_pdfiumLock = SRWLOCK_INIT;
static bool g_pdfiumTried = false;
static bool g_pdfiumReady = false;

template <typename T>
static bool Bind(HMODULE dll, T& fn, const char* name) {
  fn = reinterpret_cast<T>(GetProcAddress(dll, name));
  return fn != nullptr;
}

// Call with g_pdfiumLock held
static bool EnsurePdfium() {
  if (g_pdfiumTried) return g_pdfiumReady;
  g_pdfiumTried = true;

  wchar_t path[MAX_PATH];
  DWORD len = GetModuleFileNameW(g_module, path, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) return false;
  wchar_t* slash = wcsrchr(path, L'\\');
  if (!slash || (slash - path) + 12 >= MAX_PATH) return false;
  wcscpy_s(slash + 1, static_cast<size_t>(MAX_PATH - (slash + 1 - path)), L"pdfium.dll");

  HMODULE dll = LoadLibraryExW(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (!dll) return false;
  bool ok = Bind(dll, pdfium.InitLibrary, "FPDF_InitLibrary") &&
            Bind(dll, pdfium.LoadMemDocument64, "FPDF_LoadMemDocument64") &&
            Bind(dll, pdfium.GetPageCount, "FPDF_GetPageCount") &&
            Bind(dll, pdfium.LoadPage, "FPDF_LoadPage") &&
            Bind(dll, pdfium.GetPageWidthF, "FPDF_GetPageWidthF") &&
            Bind(dll, pdfium.GetPageHeightF, "FPDF_GetPageHeightF") &&
            Bind(dll, pdfium.BitmapCreateEx, "FPDFBitmap_CreateEx") &&
            Bind(dll, pdfium.BitmapFillRect, "FPDFBitmap_FillRect") &&
            Bind(dll, pdfium.RenderPageBitmap, "FPDF_RenderPageBitmap") &&
            Bind(dll, pdfium.BitmapDestroy, "FPDFBitmap_Destroy") &&
            Bind(dll, pdfium.ClosePage, "FPDF_ClosePage") &&
            Bind(dll, pdfium.CloseDocument, "FPDF_CloseDocument");
  if (!ok) return false;
  // pdfium.dll stays loaded for the life of the process
  pdfium.InitLibrary();
  g_pdfiumReady = true;
  return true;
}

/* ------------------------------------------------------------------ */
/* Thumbnail provider                                                   */
/* ------------------------------------------------------------------ */

class ThumbnailProvider final : public IInitializeWithStream,
                                public IThumbnailProvider {
 public:
  ThumbnailProvider() { InterlockedIncrement(&g_locks); }

  // IUnknown
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    static const QITAB qit[] = {
        QITABENT(ThumbnailProvider, IInitializeWithStream),
        QITABENT(ThumbnailProvider, IThumbnailProvider),
        {nullptr, 0},
    };
    return QISearch(this, qit, riid, ppv);
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return n;
  }

  // IInitializeWithStream: read the whole file (PDFs keep their index at the end)
  IFACEMETHODIMP Initialize(IStream* stream, DWORD) override {
    if (!stream) return E_INVALIDARG;
    if (!data_.empty()) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
    STATSTG stat = {};
    if (FAILED(stream->Stat(&stat, STATFLAG_NONAME))) return E_FAIL;
    ULONGLONG size = stat.cbSize.QuadPart;
    if (size < 8 || size > kMaxBytes) return E_FAIL;
    LARGE_INTEGER start = {};
    stream->Seek(start, STREAM_SEEK_SET, nullptr);
    try {
      data_.resize(static_cast<size_t>(size));
    } catch (const std::bad_alloc&) {
      return E_OUTOFMEMORY;
    }
    size_t done = 0;
    while (done < data_.size()) {
      ULONG want = static_cast<ULONG>(std::min<size_t>(data_.size() - done, 1 << 20));
      ULONG got = 0;
      HRESULT hr = stream->Read(data_.data() + done, want, &got);
      if (FAILED(hr) || got == 0) break;
      done += got;
    }
    if (done != data_.size()) {
      data_.clear();
      return E_FAIL;
    }
    return S_OK;
  }

  // IThumbnailProvider: the first page, scaled to fit cx x cx, on white
  IFACEMETHODIMP GetThumbnail(UINT cx, HBITMAP* out, WTS_ALPHATYPE* alpha) override {
    if (!out || !alpha || cx == 0) return E_INVALIDARG;
    *out = nullptr;
    *alpha = WTSAT_RGB;
    if (data_.empty()) return E_UNEXPECTED;

    AcquireSRWLockExclusive(&g_pdfiumLock);
    HRESULT hr = Render(cx, out);
    ReleaseSRWLockExclusive(&g_pdfiumLock);
    return hr;
  }

 private:
  ~ThumbnailProvider() { InterlockedDecrement(&g_locks); }

  HRESULT Render(UINT cx, HBITMAP* out) {
    if (!EnsurePdfium()) return E_FAIL;
    // Password-protected or damaged files fail here: Explorer keeps the icon
    FPDF_DOCUMENT doc = pdfium.LoadMemDocument64(data_.data(), data_.size(), nullptr);
    if (!doc) return E_FAIL;
    HRESULT hr = E_FAIL;
    FPDF_PAGE page = pdfium.GetPageCount(doc) > 0 ? pdfium.LoadPage(doc, 0) : nullptr;
    if (page) {
      hr = RenderPage(page, cx, out);
      pdfium.ClosePage(page);
    }
    pdfium.CloseDocument(doc);
    return hr;
  }

  static HRESULT RenderPage(FPDF_PAGE page, UINT cx, HBITMAP* out) {
    double w = pdfium.GetPageWidthF(page);
    double h = pdfium.GetPageHeightF(page);
    if (!(w > 0 && h > 0)) return E_FAIL;
    double scale = cx / std::max(w, h);
    int bw = std::max(1, static_cast<int>(std::lround(w * scale)));
    int bh = std::max(1, static_cast<int>(std::lround(h * scale)));

    BITMAPINFO info = {};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = bw;
    info.bmiHeader.biHeight = -bh;  // top-down, like PDFium's buffer
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!dib || !bits) return E_OUTOFMEMORY;

    // PDFium draws straight into the DIB's pixels
    FPDF_BITMAP bitmap = pdfium.BitmapCreateEx(bw, bh, kBitmapBGRA, bits, bw * 4);
    if (!bitmap) {
      DeleteObject(dib);
      return E_FAIL;
    }
    pdfium.BitmapFillRect(bitmap, 0, 0, bw, bh, 0xFFFFFFFF);
    pdfium.RenderPageBitmap(bitmap, page, 0, 0, bw, bh, 0, kRenderAnnotations);
    pdfium.BitmapDestroy(bitmap);
    *out = dib;
    return S_OK;
  }

  long refs_ = 1;
  std::vector<BYTE> data_;
};

/* ------------------------------------------------------------------ */
/* Class factory and DLL exports                                        */
/* ------------------------------------------------------------------ */

class ClassFactory final : public IClassFactory {
 public:
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    static const QITAB qit[] = {QITABENT(ClassFactory, IClassFactory), {nullptr, 0}};
    return QISearch(this, qit, riid, ppv);
  }
  // Static instance: reference counting is a no-op
  IFACEMETHODIMP_(ULONG) AddRef() override { return 2; }
  IFACEMETHODIMP_(ULONG) Release() override { return 1; }

  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    auto* provider = new (std::nothrow) ThumbnailProvider();
    if (!provider) return E_OUTOFMEMORY;
    HRESULT hr = provider->QueryInterface(riid, ppv);
    provider->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock)
      InterlockedIncrement(&g_locks);
    else
      InterlockedDecrement(&g_locks);
    return S_OK;
  }
};

static ClassFactory g_factory;

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (!IsEqualCLSID(clsid, CLSID_PaperwingThumbnails)) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_locks == 0 ? S_OK : S_FALSE; }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = module;
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}
