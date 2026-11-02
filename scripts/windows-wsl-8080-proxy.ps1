param(
  [string]$Distro = "Ubuntu-24.04",
  [int]$ListenPort = 8080,
  [int]$TargetPort = 8080
)

$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

public sealed class WslLoopbackProxy
{
    private readonly string _distro;
    private readonly int _listenPort;
    private readonly int _targetPort;

    public WslLoopbackProxy(string distro, int listenPort, int targetPort)
    {
        _distro = distro;
        _listenPort = listenPort;
        _targetPort = targetPort;
    }

    private string ResolveWslIp()
    {
        var psi = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            Arguments = "-d " + _distro + " -- hostname -I",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using (var p = Process.Start(psi))
        {
            if (p == null) throw new InvalidOperationException("Failed to start wsl.exe");
            string output = p.StandardOutput.ReadToEnd();
            if (!p.WaitForExit(10000)) {
                try { p.Kill(); } catch {}
                throw new TimeoutException("wsl.exe hostname -I timed out");
            }
            if (p.ExitCode != 0) throw new InvalidOperationException("wsl.exe hostname -I failed");
            string ip = output.Split((char[])null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
            if (String.IsNullOrWhiteSpace(ip)) throw new InvalidOperationException("WSL IP not found");
            return ip;
        }
    }

    public async Task RunAsync(CancellationToken token)
    {
        var listener = new TcpListener(IPAddress.Loopback, _listenPort);
        listener.Start();
        Console.WriteLine("Listening on 127.0.0.1:" + _listenPort);
        try
        {
            while (!token.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                _ = HandleClientAsync(client);
            }
        }
        finally
        {
            listener.Stop();
        }
    }

    private async Task HandleClientAsync(TcpClient client)
    {
        using (client)
        using (var upstream = new TcpClient())
        {
            try
            {
                string ip = ResolveWslIp();
                await upstream.ConnectAsync(ip, _targetPort).ConfigureAwait(false);
                using (var downstreamStream = client.GetStream())
                using (var upstreamStream = upstream.GetStream())
                {
                    var a = downstreamStream.CopyToAsync(upstreamStream);
                    var b = upstreamStream.CopyToAsync(downstreamStream);
                    await Task.WhenAny(a, b).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
            }
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$proxy = [WslLoopbackProxy]::new($Distro, $ListenPort, $TargetPort)
$cts = [System.Threading.CancellationTokenSource]::new()
try {
  $proxy.RunAsync($cts.Token).GetAwaiter().GetResult()
} finally {
  $cts.Cancel()
  $cts.Dispose()
}
