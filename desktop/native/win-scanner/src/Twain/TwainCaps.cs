using System;
using System.Collections.Generic;
using System.Linq;
using NTwain;
using NTwain.Data;

namespace Paperwing.Scan.Twain;

/// <summary>A capability's values as read: a list, a range, or nothing</summary>
internal sealed class CapRead
{
    public List<double>? List { get; set; }
    public RangeCap? Range { get; set; }
    public bool Present => (List != null && List.Count > 0) || Range != null;
}

/// <summary>
/// Reading and setting TWAIN capabilities defensively: drivers differ in
/// what they support and how they answer, and a refused setting mustn't stop
/// a scan.
/// </summary>
internal static class TwainCaps
{
    public static double Fix(TWFix32 value) => value;

    /// <summary>
    /// The raw values. Ranges are read as ranges, never enumerated (NTwain
    /// would loop forever on a driver that reports a step of 0).
    /// </summary>
    public static CapRead Read<T>(IReadOnlyCapWrapper<T> cap)
    {
        try
        {
            var raw = cap.GetValuesRaw();
            switch (raw.ContainerType)
            {
                case ContainerType.Range:
                    var min = ToDouble(raw.RangeMinValue);
                    var max = ToDouble(raw.RangeMaxValue);
                    if (min == null || max == null) return new CapRead();
                    var step = ToDouble(raw.RangeStepSize) ?? 0;
                    var dflt = ToDouble(raw.RangeDefaultValue) ?? ToDouble(raw.RangeCurrentValue) ?? min.Value;
                    return new CapRead { Range = new RangeCap(min.Value, max.Value, step > 0 ? step : 1, dflt) };
                case ContainerType.Enum:
                case ContainerType.Array:
                    return new CapRead { List = (raw.CollectionValues ?? new List<object>()).Select(ToDouble).Where(v => v != null).Select(v => v!.Value).ToList() };
                case ContainerType.OneValue:
                    var one = ToDouble(raw.OneValue);
                    return new CapRead { List = one != null ? new List<double> { one.Value } : new List<double>() };
                default:
                    return new CapRead();
            }
        }
        catch (Exception)
        {
            return new CapRead();
        }
    }

    private static double? ToDouble(object? value)
    {
        try
        {
            return value switch
            {
                null => null,
                TWFix32 f => f,
                IConvertible c => c.ToDouble(System.Globalization.CultureInfo.InvariantCulture),
                _ => null,
            };
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// Whether a capability is there. Some older drivers don't answer
    /// "query support", so a readable value counts too.
    /// </summary>
    public static bool Supported<T>(IReadOnlyCapWrapper<T> cap)
    {
        try
        {
            if (cap.IsSupported) return true;
        }
        catch (Exception)
        {
            // Treat a failed query as "maybe": try reading it
        }
        return Read(cap).Present;
    }

    public static bool Settable<T>(IReadOnlyCapWrapper<T> cap)
    {
        try
        {
            return cap.IsSupported ? cap.CanSet : Read(cap).Present;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public static T? Current<T>(IReadOnlyCapWrapper<T> cap) where T : struct
    {
        try
        {
            return cap.GetCurrent();
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static bool Set<T>(ICapWrapper<T> cap, T value)
    {
        try
        {
            var rc = cap.SetValue(value);
            return rc == ReturnCode.Success || rc == ReturnCode.CheckStatus;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>The nearest value the driver allows (resolutions); returns what was set, or 0</summary>
    public static int SetClosest(ICapWrapper<TWFix32> cap, int wanted)
    {
        var read = Read(cap);
        double value = wanted;
        if (read.List is { Count: > 0 } list)
            value = Geometry.Closest(wanted, list.Select(v => (int)Math.Round(v)));
        else if (read.Range is RangeCap r)
            value = Geometry.Snap(wanted, r.Min, r.Max, r.Step);
        return Set(cap, (TWFix32)value) ? (int)Math.Round(value) : 0;
    }

    /// <summary>A brightness/contrast/threshold value in the driver's units, clamped to its range</summary>
    public static void SetInRange(ICapWrapper<TWFix32> cap, double? wanted)
    {
        if (wanted is not double v) return;
        if (Read(cap).Range is RangeCap r) v = Geometry.Snap(v, r.Min, r.Max, r.Step);
        Set(cap, (TWFix32)v);
    }

    /// <summary>A setting's range for caps, or null</summary>
    public static RangeCap? RangeOf(IReadOnlyCapWrapper<TWFix32> cap)
    {
        var r = Read(cap).Range;
        return r != null && r.Max > r.Min ? r : null;
    }
}
