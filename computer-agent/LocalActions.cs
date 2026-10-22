using System.Diagnostics;
using System.Text;

namespace Smartz.ComputerAgent;

/// <summary>A program the user added on this computer; the phone can start it by name only.</summary>
internal sealed record AgentApp(string Name, string Path);

/// <summary>A command the user added on this computer; the phone can run it by name only.</summary>
internal sealed record AgentCommand(string Name, string Path, string Arguments);

/// <summary>The requested name is not in this computer's local allowlist.</summary>
internal sealed class LocalActionNotFoundException(string kind, IEnumerable<string> available)
    : Exception($"{kind} not in local allowlist")
{
    public string Kind { get; } = kind;
    public string[] Available { get; } = available.Take(30).ToArray();
}

/// <summary>
/// Everything the agent starts on this computer lives here, and only these paths
/// start a process: a document inside an authorized folder, an http(s) link, or a
/// program/command the user added locally. The server sends names, never paths or command lines.
/// </summary>
internal static class LocalActions
{
    private const int CommandTimeoutSeconds = 120;
    // Results are capped at 7000 JSON bytes, and non-ASCII text is escaped (\uXXXX, 6 bytes a character).
    private const int MaxOutputCharacters = 900;

    private static readonly HashSet<string> BlockedOpenExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
        ".msi", ".msp", ".scr", ".pif", ".lnk", ".hta", ".cpl", ".jar", ".reg", ".application",
        ".appref-ms", ".url", ".scf", ".inf", ".sys", ".dll",
    };

    /// <summary>Opens a document (already resolved inside an authorized folder) with its default app.</summary>
    public static object OpenDocument(string fullPath, string relativePath)
    {
        if (!File.Exists(fullPath)) throw new FileNotFoundException();
        if (BlockedOpenExtensions.Contains(System.IO.Path.GetExtension(fullPath))) throw new UnauthorizedAccessException();
        using var process = Process.Start(new ProcessStartInfo(fullPath) { UseShellExecute = true });
        return new { opened = relativePath };
    }

    public static object OpenUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            uri.UserInfo.Length > 0)
        {
            throw new InvalidDataException();
        }
        using var process = Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        return new { opened = uri.Host };
    }

    public static object OpenApp(IReadOnlyList<AgentApp> apps, string requestedName)
    {
        var app = FindByName(apps, a => a.Name, requestedName, "app");
        if (!File.Exists(app.Path)) throw new FileNotFoundException();
        using var process = Process.Start(new ProcessStartInfo(app.Path)
        {
            UseShellExecute = true,
            WorkingDirectory = System.IO.Path.GetDirectoryName(app.Path) ?? string.Empty,
        });
        return new { started = app.Name };
    }

    public static object RunCommand(IReadOnlyList<AgentCommand> commands, string requestedName, CancellationToken cancellationToken)
    {
        var command = FindByName(commands, c => c.Name, requestedName, "command");
        if (!File.Exists(command.Path)) throw new FileNotFoundException();

        var output = new StringBuilder();
        void Append(string? line)
        {
            if (line is null) return;
            lock (output)
            {
                if (output.Length < MaxOutputCharacters) output.AppendLine(line);
            }
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(command.Path, command.Arguments ?? string.Empty)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = System.IO.Path.GetDirectoryName(command.Path) ?? string.Empty,
            },
        };
        process.OutputDataReceived += (_, e) => Append(e.Data);
        process.ErrorDataReceived += (_, e) => Append(e.Data);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        var deadline = DateTime.UtcNow.AddSeconds(CommandTimeoutSeconds);
        while (!process.WaitForExit(250))
        {
            if (cancellationToken.IsCancellationRequested || DateTime.UtcNow > deadline)
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                cancellationToken.ThrowIfCancellationRequested();
                throw new TimeoutException();
            }
        }
        process.WaitForExit();

        string text;
        lock (output) text = output.ToString().Trim();
        if (text.Length > MaxOutputCharacters) text = text[..MaxOutputCharacters];
        return new { command = command.Name, exitCode = process.ExitCode, output = text };
    }

    /// <summary>Exact name first (ignoring case), then a single partial match.</summary>
    private static T FindByName<T>(IReadOnlyList<T> items, Func<T, string> name, string requested, string kind)
    {
        var wanted = (requested ?? string.Empty).Trim();
        var exact = items.Where(item => string.Equals(name(item).Trim(), wanted, StringComparison.OrdinalIgnoreCase)).ToList();
        if (exact.Count == 1) return exact[0];
        var partial = items.Where(item =>
            name(item).Contains(wanted, StringComparison.OrdinalIgnoreCase) ||
            wanted.Contains(name(item).Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        if (wanted.Length > 0 && partial.Count == 1) return partial[0];
        throw new LocalActionNotFoundException(kind, items.Select(name));
    }
}
