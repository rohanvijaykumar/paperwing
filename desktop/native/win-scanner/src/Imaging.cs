using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace Paperwing.Scan;

/// <summary>Turning what drivers deliver into PNG files</summary>
internal static class Imaging
{
    /// <summary>
    /// Saves a page as PNG at its resolution. The file appears under its
    /// final name only once complete, so Paperwing never reads half a page.
    /// </summary>
    public static void SavePng(Image image, string path, int dpi, bool invert)
    {
        if (dpi > 0 && image is Bitmap bmp) bmp.SetResolution(dpi, dpi);
        if (invert) InvertIndexed(image);
        var part = path + ".part";
        try
        {
            image.Save(part, ImageFormat.Png);
            if (File.Exists(path)) File.Delete(path);
            File.Move(part, path);
        }
        finally
        {
            if (File.Exists(part)) File.Delete(part);
        }
    }

    /// <summary>
    /// "Invert black and white images": black and white (and grey) pages
    /// arrive with a palette, so swapping the palette inverts them for free.
    /// </summary>
    public static bool InvertIndexed(Image image)
    {
        if ((image.PixelFormat & PixelFormat.Indexed) == 0) return false;
        var palette = image.Palette;
        var entries = palette.Entries;
        for (var i = 0; i < entries.Length; i++)
        {
            var c = entries[i];
            entries[i] = Color.FromArgb(c.A, 255 - c.R, 255 - c.G, 255 - c.B);
        }
        image.Palette = palette;
        return true;
    }

    /// <summary>The image's own resolution, if it has a believable one</summary>
    public static int ResolutionOf(Image image)
    {
        var r = image.HorizontalResolution;
        // GDI+ reports 96 when a file has none, which is never a scan's
        return r >= 30 && r <= 20000 && Math.Abs(r - 96) > 0.5 ? (int)Math.Round(r) : 0;
    }

    public static MemoryStream ToMemory(Stream stream)
    {
        if (stream is MemoryStream ms && ms.Position == 0) return ms;
        var copy = new MemoryStream();
        stream.CopyTo(copy);
        copy.Position = 0;
        return copy;
    }
}

/// <summary>
/// A TWAIN memory transfer: the page arrives in strips (rows, or tiles with
/// offsets) of raw pixels, assembled here into a bitmap. Handles pages of
/// unknown length (ICAP_UNDEFINEDIMAGESIZE: ImageLength -1) by growing, and
/// drivers that leave the strip width out (Kyocera; NAPS2 found this).
/// </summary>
internal sealed class StripImage
{
    private readonly int _bitsPerPixel;
    private readonly bool _whiteIsZero;
    private readonly int _knownHeight;
    private int _width;
    private int _rowBytes;
    private byte[] _data;
    private int _rows;

    /// <param name="width">pixels (0 if the driver didn't say)</param>
    /// <param name="height">pixels, or -1 if the page's length isn't known yet</param>
    /// <param name="bitsPerPixel">1 (black and white), 8 (grey) or 24 (RGB)</param>
    /// <param name="whiteIsZero">ICAP_PIXELFLAVOR "vanilla": 0 is white</param>
    public StripImage(int width, int height, int bitsPerPixel, bool whiteIsZero)
    {
        if (bitsPerPixel != 1 && bitsPerPixel != 8 && bitsPerPixel != 24)
            throw new ScanException(ErrorCodes.Unsupported,
                $"The scanner sent {bitsPerPixel}-bit pixels, which Paperwing can't read in memory mode. Choose the native transfer method.");
        _bitsPerPixel = bitsPerPixel;
        _whiteIsZero = whiteIsZero;
        _knownHeight = height;
        _width = Math.Max(0, width);
        _rowBytes = RowBytes(_width);
        _data = new byte[_rowBytes * Math.Max(16, height > 0 ? height : 256)];
    }

    public int Width => _width;
    public int Height => _rows;
    /// <summary>All of a page of known length has arrived</summary>
    public bool Complete => _knownHeight > 0 && _rows >= _knownHeight && _width > 0;
    public bool IsEmpty => _rows == 0 || _width == 0;

    private int RowBytes(int width) => ((width * _bitsPerPixel + 31) / 32) * 4;

    public void Add(byte[] buffer, int columns, int rows, int xOffset, int yOffset, int bytesPerRow)
    {
        if (columns <= 0 && bytesPerRow > 0) columns = bytesPerRow * 8 / _bitsPerPixel;
        if (columns <= 0 || rows <= 0 || bytesPerRow <= 0) return;
        rows = Math.Min(rows, buffer.Length / bytesPerRow);
        EnsureSize(xOffset + columns, yOffset + rows);
        var srcRowBytes = (columns * _bitsPerPixel + 7) / 8;
        var xBytes = xOffset * _bitsPerPixel / 8;
        for (var r = 0; r < rows; r++)
        {
            var src = r * bytesPerRow;
            var dst = (yOffset + r) * _rowBytes + xBytes;
            var count = Math.Min(srcRowBytes, Math.Min(buffer.Length - src, _rowBytes - xBytes));
            if (count <= 0) continue;
            if (_bitsPerPixel == 24)
            {
                // TWAIN sends RGB; GDI+ keeps BGR
                for (var i = 0; i + 2 < count; i += 3)
                {
                    _data[dst + i] = buffer[src + i + 2];
                    _data[dst + i + 1] = buffer[src + i + 1];
                    _data[dst + i + 2] = buffer[src + i];
                }
            }
            else
                Buffer.BlockCopy(buffer, src, _data, dst, count);
        }
        _rows = Math.Max(_rows, yOffset + rows);
    }

    private void EnsureSize(int width, int height)
    {
        if (width > _width)
        {
            var newRowBytes = RowBytes(width);
            var grown = new byte[newRowBytes * Math.Max(height, _data.Length / Math.Max(1, _rowBytes))];
            for (var r = 0; r < _rows; r++) Buffer.BlockCopy(_data, r * _rowBytes, grown, r * newRowBytes, _rowBytes);
            _data = grown;
            _width = width;
            _rowBytes = newRowBytes;
        }
        if ((long)height * _rowBytes > _data.Length)
        {
            var grown = new byte[Math.Max((long)height * _rowBytes, (long)_data.Length * 2)];
            Buffer.BlockCopy(_data, 0, grown, 0, _data.Length);
            _data = grown;
        }
    }

    public Bitmap ToBitmap(int dpi)
    {
        if (IsEmpty) throw new InvalidOperationException("No image data");
        var format = _bitsPerPixel switch
        {
            1 => PixelFormat.Format1bppIndexed,
            8 => PixelFormat.Format8bppIndexed,
            _ => PixelFormat.Format24bppRgb,
        };
        var bmp = new Bitmap(_width, _rows, format);
        try
        {
            if (_bitsPerPixel != 24)
            {
                var palette = bmp.Palette;
                var n = palette.Entries.Length;
                for (var i = 0; i < n; i++)
                {
                    var v = n == 2 ? i * 255 : i;
                    if (_whiteIsZero) v = 255 - v;
                    palette.Entries[i] = Color.FromArgb(v, v, v);
                }
                bmp.Palette = palette;
            }
            var locked = bmp.LockBits(new Rectangle(0, 0, _width, _rows), ImageLockMode.WriteOnly, format);
            try
            {
                for (var r = 0; r < _rows; r++)
                    Marshal.Copy(_data, r * _rowBytes, locked.Scan0 + r * locked.Stride, Math.Min(_rowBytes, Math.Abs(locked.Stride)));
            }
            finally
            {
                bmp.UnlockBits(locked);
            }
            if (dpi > 0) bmp.SetResolution(dpi, dpi);
            return bmp;
        }
        catch
        {
            bmp.Dispose();
            throw;
        }
    }
}
