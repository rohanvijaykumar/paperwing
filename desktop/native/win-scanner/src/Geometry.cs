using System;
using System.Collections.Generic;
using System.Linq;

namespace Paperwing.Scan;

/// <summary>Where a scanner lines paper up across (or down) its area</summary>
internal enum Align
{
    Start,
    Center,
    End,
}

/// <summary>Scan areas, resolutions and value ranges: inches to driver units</summary>
internal static class Geometry
{
    /// <summary>Smallest area worth asking a scanner for (inches)</summary>
    private const double MinSide = 0.1;

    /// <summary>
    /// The area to scan, in inches: the explicit area, else the paper size
    /// placed where this scanner aligns paper, else everything. Clamped to
    /// the scanner's area (maxW/maxH; 0 when unknown).
    /// </summary>
    public static RectIn ResolveArea(ScanOptions o, double maxW, double maxH, Align across, Align down)
    {
        RectIn r;
        if (o.Area is RectIn a)
            r = a;
        else if (o.Paper is RectIn p)
        {
            var w = maxW > 0 ? Math.Min(p.Width, maxW) : p.Width;
            var h = maxH > 0 ? Math.Min(p.Height, maxH) : p.Height;
            r = new RectIn(Offset(across, w, maxW), Offset(down, h, maxH), w, h);
        }
        else
            r = new RectIn(0, 0, maxW, maxH);
        return Clamp(r, maxW, maxH);
    }

    private static double Offset(Align align, double size, double max)
    {
        if (max <= 0) return 0;
        return align switch
        {
            Align.Center => Math.Max(0, (max - size) / 2),
            Align.End => Math.Max(0, max - size),
            _ => 0,
        };
    }

    public static RectIn Clamp(RectIn r, double maxW, double maxH)
    {
        double x = r.X, y = r.Y, w = r.Width, h = r.Height;
        if (maxW > 0)
        {
            x = Math.Min(Math.Max(0, x), Math.Max(0, maxW - MinSide));
            w = Math.Min(w, maxW - x);
        }
        if (maxH > 0)
        {
            y = Math.Min(Math.Max(0, y), Math.Max(0, maxH - MinSide));
            h = Math.Min(h, maxH - y);
        }
        return new RectIn(x, y, Math.Max(MinSide, w), Math.Max(MinSide, h));
    }

    public static int ToPixels(double inches, int dpi) => (int)Math.Round(inches * dpi, MidpointRounding.AwayFromZero);

    /// <summary>WIA sizes are in thousandths of an inch</summary>
    public static double FromThousandths(int thousandths) => thousandths / 1000.0;

    public static int ThousandthsToPixels(int thousandths, int dpi) => (int)((long)thousandths * dpi / 1000);

    /// <summary>
    /// The WIA scan window in pixels: XPOS, YPOS, XEXTENT, YEXTENT, kept
    /// inside the scanner's area. With offsetWidth, XEXTENT is the right
    /// edge rather than the width (drivers that read it that way; NAPS2 has
    /// the same switch).
    /// </summary>
    public static (int XPos, int YPos, int XExtent, int YExtent) WiaWindow(
        RectIn r, int xDpi, int yDpi, int maxWidthPx, int maxHeightPx, bool offsetWidth)
    {
        var xPos = ToPixels(r.X, xDpi);
        var yPos = ToPixels(r.Y, yDpi);
        var xExt = Math.Max(1, ToPixels(r.Width, xDpi));
        var yExt = Math.Max(1, ToPixels(r.Height, yDpi));
        if (maxWidthPx > 0)
        {
            xPos = Math.Min(xPos, maxWidthPx - 1);
            xExt = Math.Min(xExt, maxWidthPx - xPos);
        }
        if (maxHeightPx > 0)
        {
            yPos = Math.Min(yPos, maxHeightPx - 1);
            yExt = Math.Min(yExt, maxHeightPx - yPos);
        }
        if (offsetWidth) xExt += xPos;
        return (xPos, yPos, xExt, yExt);
    }

    /// <summary>The value in the list nearest to the one wanted (ties: the higher)</summary>
    public static int Closest(int wanted, IEnumerable<int> values)
    {
        var best = wanted;
        var bestDistance = long.MaxValue;
        foreach (var v in values)
        {
            var d = Math.Abs((long)v - wanted);
            if (d < bestDistance || (d == bestDistance && v > best))
            {
                best = v;
                bestDistance = d;
            }
        }
        return best;
    }

    /// <summary>A value clamped into [min, max] and snapped to the step from min</summary>
    public static double Snap(double value, double min, double max, double step)
    {
        if (max < min) (min, max) = (max, min);
        var v = Math.Min(Math.Max(value, min), max);
        if (step > 0)
        {
            v = min + Math.Round((v - min) / step, MidpointRounding.AwayFromZero) * step;
            if (v > max) v -= step;
        }
        return Math.Min(Math.Max(v, min), max);
    }

    /// <summary>The preview resolution: the supported one nearest 75 dpi, at least 50</summary>
    public static int PreviewDpi(IEnumerable<int>? list, RangeCap? range)
    {
        const int Wanted = 75;
        if (list != null)
        {
            var usable = list.Where(d => d >= 50).ToList();
            if (usable.Count > 0) return Closest(Wanted, usable);
        }
        if (range != null) return (int)Snap(Math.Max(Wanted, range.Min), range.Min, range.Max, range.Step);
        return Wanted;
    }

    /// <summary>Inches for the protocol: 3 decimals is a thousandth of an inch</summary>
    public static double Round(double inches) => Math.Round(inches, 3);
}
