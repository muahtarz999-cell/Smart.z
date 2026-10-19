using System.Security.Cryptography;
using System.Text.Json;

namespace Smartz.ComputerAgent;

internal sealed record AgentConfiguration(
    string Origin,
    string DeviceId,
    string Label,
    string PrivateKey,
    string[] AuthorizedRoots)
{
    private static readonly string ConfigurationPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Smartz",
        "ComputerAgent",
        "device.bin");

    public static AgentConfiguration? Load()
    {
        if (!File.Exists(ConfigurationPath)) return null;

        var protectedBytes = File.ReadAllBytes(ConfigurationPath);
        var plainBytes = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);
        try
        {
            return JsonSerializer.Deserialize<AgentConfiguration>(plainBytes)
                ?? throw new InvalidDataException("إعدادات وكيل الكمبيوتر غير صالحة.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plainBytes);
            CryptographicOperations.ZeroMemory(protectedBytes);
        }
    }

    public void Save()
    {
        var directory = Path.GetDirectoryName(ConfigurationPath)!;
        Directory.CreateDirectory(directory);
        var plainBytes = JsonSerializer.SerializeToUtf8Bytes(this);
        var protectedBytes = ProtectedData.Protect(
            plainBytes,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);
        CryptographicOperations.ZeroMemory(plainBytes);
        try
        {
            var temporaryPath = ConfigurationPath + ".tmp";
            using (var stream = new FileStream(
                temporaryPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.WriteThrough))
            {
                stream.Write(protectedBytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, ConfigurationPath, overwrite: true);
            File.SetAttributes(ConfigurationPath, FileAttributes.Hidden);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(protectedBytes);
        }
    }
}
