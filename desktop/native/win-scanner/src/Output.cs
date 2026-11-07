using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;

namespace Paperwing.Scan;

/// <summary>JSON lines on stdout, one object per line, flushed at once</summary>
internal sealed class Output
{
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private readonly Stream _stream;
    private readonly object _lock = new();
    private int _broken;

    public Output(Stream stream)
    {
        _stream = stream;
    }

    /// <summary>Paperwing went away (stdout closed): stop and let go of the scanner</summary>
    public event Action? Broken;

    public bool IsBroken => _broken != 0;

    public void Emit(Dictionary<string, object?> message)
    {
        var bytes = Utf8.GetBytes(Json.Write(message) + "\n");
        lock (_lock)
        {
            if (_broken != 0) return;
            try
            {
                _stream.Write(bytes, 0, bytes.Length);
                _stream.Flush();
            }
            catch (IOException)
            {
                MarkBroken();
            }
            catch (ObjectDisposedException)
            {
                MarkBroken();
            }
        }
    }

    private void MarkBroken()
    {
        if (Interlocked.Exchange(ref _broken, 1) == 0) Broken?.Invoke();
    }

    public void Error(string code, string message) => Emit(new Dictionary<string, object?>
    {
        ["type"] = "error",
        ["code"] = code,
        ["message"] = message,
    });

    public void Status(string message) => Emit(new Dictionary<string, object?>
    {
        ["type"] = "status",
        ["message"] = message,
    });
}
