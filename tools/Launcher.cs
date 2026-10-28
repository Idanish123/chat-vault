using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
internal static class Launcher {
    [STAThread]
    private static void Main() {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "Start.ps1");
            if (!File.Exists(script)) throw new Exception("Extract the complete Chat Vault package before opening it.");
            var start = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Quiet",
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(start);
        } catch (Exception error) { MessageBox.Show(error.Message, "Chat Vault", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
}
