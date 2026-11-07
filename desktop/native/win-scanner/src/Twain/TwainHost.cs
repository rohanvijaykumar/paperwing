using System;
using System.Threading;
using System.Windows.Forms;
using NTwain;

namespace Paperwing.Scan.Twain;

/// <summary>
/// The thread TWAIN runs on: an STA thread with a Windows message loop and a
/// hidden window. TWAIN drivers talk to their application through window
/// messages, so every TWAIN call happens here (NAPS2 does the same with its
/// own message pump).
/// </summary>
internal sealed class TwainHost : IDisposable
{
    private readonly Thread _thread;
    private readonly ManualResetEventSlim _ready = new(false);
    private HostWindow? _window;
    private Exception? _startError;

    public TwainHost(IntPtr owner)
    {
        _thread = new Thread(() => Run(owner)) { IsBackground = true, Name = "TWAIN" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        if (!_ready.Wait(TimeSpan.FromSeconds(15)))
            throw new ScanException(ErrorCodes.Failed, "TWAIN's message thread didn't start");
        if (_startError != null) throw ErrorMap.From(_startError);
    }

    public IntPtr Handle { get; private set; }
    public uint ThreadId { get; private set; }

    private void Run(IntPtr owner)
    {
        try
        {
            ThreadId = Native.GetCurrentThreadId();
            _window = new HostWindow();
            // Creating the handle installs the WinForms synchronization context
            Handle = _window.Handle;
            // Paperwing's window owns ours, so the scanner's own windows open in front of it
            Native.SetOwner(Handle, owner);
            _window.BeginInvoke(new Action(_ready.Set));
            Application.Run();
        }
        catch (Exception e)
        {
            _startError = e;
            _ready.Set();
        }
    }

    /// <summary>Runs on the TWAIN thread and waits; exceptions come back to the caller</summary>
    public T Invoke<T>(Func<T> func)
    {
        T result = default!;
        Exception? error = null;
        _window!.Invoke(new Action(() =>
        {
            try
            {
                result = func();
            }
            catch (Exception e)
            {
                error = e;
            }
        }));
        if (error != null) throw error;
        return result;
    }

    public void Invoke(Action action) => Invoke(() =>
    {
        action();
        return true;
    });

    /// <summary>Runs on the TWAIN thread later, without waiting</summary>
    public void BeginInvoke(Action action)
    {
        try
        {
            _window?.BeginInvoke(action);
        }
        catch (InvalidOperationException)
        {
            // The thread has already ended
        }
    }

    /// <summary>For TwainSession.Open; only valid on the TWAIN thread, inside its message loop</summary>
    public MessageLoopHook CreateHook() => new WindowsFormsMessageLoopHook(Handle);

    public void Dispose()
    {
        BeginInvoke(() =>
        {
            _window?.Dispose();
            Application.ExitThread();
        });
        _thread.Join(TimeSpan.FromSeconds(3));
    }

    /// <summary>Never shown: it exists for its handle and message loop</summary>
    private sealed class HostWindow : Form
    {
        public HostWindow()
        {
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            Text = "Paperwing scanning";
        }

        protected override void SetVisibleCore(bool value) => base.SetVisibleCore(false);
    }
}
