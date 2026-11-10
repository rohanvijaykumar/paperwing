// The stand-in certificate helper's launcher on Windows (development only):
// the app runs its helper as an .exe, so this runs helper.cjs with Node and
// passes its JSON line on. index.mjs compiles it with the C# compiler that
// comes with Windows (.NET Framework 4).
//   PAPERWING_CERTS_STANDIN       helper.cjs
//   PAPERWING_CERTS_STANDIN_NODE  node.exe (else node on the PATH)
using System;
using System.Diagnostics;
using System.Text;

static class Launcher
{
    static string Quote(string s)
    {
        return "\"" + s.Replace("\"", "\\\"") + "\"";
    }

    static int Main(string[] args)
    {
        var script = Environment.GetEnvironmentVariable("PAPERWING_CERTS_STANDIN");
        var node = Environment.GetEnvironmentVariable("PAPERWING_CERTS_STANDIN_NODE");
        if (string.IsNullOrEmpty(script))
        {
            Console.WriteLine("{\"type\":\"error\",\"code\":\"failed\"}");
            return 2;
        }
        var line = new StringBuilder(Quote(script));
        foreach (var a in args) line.Append(' ').Append(Quote(a));
        var info = new ProcessStartInfo(string.IsNullOrEmpty(node) ? "node" : node, line.ToString())
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
        };
        using (var p = Process.Start(info))
        {
            Console.Out.Write(p.StandardOutput.ReadToEnd());
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
