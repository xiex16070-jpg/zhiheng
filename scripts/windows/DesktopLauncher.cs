using System;
using System.Collections;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("知衡 Agent 工作台")]
[assembly: AssemblyProduct("知衡 Agent 工作台")]

internal sealed class DesktopRuntime
{
    public string Data { get; private set; }
    private readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    public DesktopRuntime(string profile) { Data = Path.GetFullPath(profile); }

    public sealed class Instance
    {
        public string url { get; set; }
        public string bootId { get; set; }
        public int pid { get; set; }
    }

    private sealed class Reply
    {
        public bool ok { get; set; }
        public Instance result { get; set; }
        public string error { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo {
        public int cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, width, height, columns, rows, fill, flags;
        public ushort show, cbReserved;
        public IntPtr data, input, output, error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfo start, out ProcessInfo process);
    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    // Desktop settings live in one Windows user profile. An unrelated developer
    // environment must not silently redirect the storage, load credentials or
    // inject Node options. User-approved tools still inherit the normal PATH.
    private ProcessStartInfo Command(string arguments)
    {
        var app = Path.Combine(root, "app");
        var node = Path.Combine(root, "runtime", "node.exe");
        if (!File.Exists(node) || !File.Exists(Path.Combine(app, "server.mjs")))
            throw new IOException("请先完整解压安装包，再打开知衡。");
        var info = new ProcessStartInfo(node, arguments) {
            UseShellExecute = false, WorkingDirectory = app
        };
        info.EnvironmentVariables.Clear();
        string[] inherit = { "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATH", "PATHEXT",
            "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
            "PROGRAMW6432", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN",
            "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "HTTP_PROXY", "HTTPS_PROXY",
            "ALL_PROXY", "NO_PROXY" };
        foreach (var key in inherit) {
            var value = Environment.GetEnvironmentVariable(key);
            if (value != null) info.EnvironmentVariables[key] = value;
        }
        info.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + info.EnvironmentVariables["PATH"];
        info.EnvironmentVariables["DATA_DIR"] = Data;
        info.EnvironmentVariables["ZHIHENG_DESKTOP"] = "1";
        info.EnvironmentVariables["HOST"] = "127.0.0.1";
        info.EnvironmentVariables["PORT"] = "43170";
        info.EnvironmentVariables["MYSQL_ENABLED"] = "false";
        info.EnvironmentVariables["REDIS_ENABLED"] = "false";
        info.EnvironmentVariables["KB_NO_OPEN"] = "1";
        return info;
    }

    private Instance Run(string arguments)
    {
        var info = Command(arguments);
        var nonce = Guid.NewGuid().ToString("N");
        var temp = Path.GetTempPath();
        var replyFile = Path.Combine(temp, "zhiheng-reply-" + nonce + ".json");
        info.EnvironmentVariables["TEMP"] = temp;
        info.EnvironmentVariables["TMP"] = temp;
        info.EnvironmentVariables["ZHIHENG_DESKTOP_REPLY"] = nonce;
        var env = info.EnvironmentVariables.Cast<DictionaryEntry>().OrderBy(x => (string)x.Key, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.Key + "=" + x.Value);
        var block = Marshal.StringToHGlobalUni(string.Join("\0", env.ToArray()) + "\0");
        try {
            var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)) };
            ProcessInfo child;
            // The .NET Framework Process.Start path inherits unrelated caller
            // handles, leaving GUI/automation capture pipes open in detached
            // servers even after this EXE exits. Pass no handles to Node.
            if (!CreateProcessW(info.FileName, new StringBuilder("\"" + info.FileName + "\" " + arguments),
                IntPtr.Zero, IntPtr.Zero, false, 0x08000000 | 0x400, block, info.WorkingDirectory, ref startup, out child))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(child.thread);
            try {
                if (WaitForSingleObject(child.process, 75000) != 0) throw new TimeoutException("本地服务未及时响应。请检查 server.log。");
            } finally { CloseHandle(child.process); }
            if (!File.Exists(replyFile)) throw new IOException("运行时未能启动。请检查是否已完整解压，以及数据目录内的 server.log。");
            var reply = new JavaScriptSerializer().Deserialize<Reply>(File.ReadAllText(replyFile, Encoding.UTF8));
            if (reply == null || !reply.ok) throw new IOException(reply != null ? reply.error : "本地服务返回了无效结果。");
            return reply.result;
        } finally {
            Marshal.FreeHGlobal(block);
            File.Delete(replyFile);
        }
    }

    public Instance Start()
    {
        var instance = Run("scripts/launch.mjs --json");
        Uri uri;
        Guid boot;
        if (instance == null || instance.pid <= 0 || !Guid.TryParseExact(instance.bootId, "D", out boot) ||
            !Uri.TryCreate(instance.url, UriKind.Absolute, out uri) || uri.Scheme != "http" ||
            uri.Host != "127.0.0.1" || uri.Port < 1 || uri.UserInfo != "" || uri.PathAndQuery != "/" || uri.Fragment != "")
            throw new IOException("无法确认本地工作台地址。请检查数据目录内的 server.log。");
        return instance;
    }

    public void Stop(Instance expected)
    {
        // The UUID only comes from the independently validated Start result.
        Run("scripts/stop.mjs" + (expected == null ? "" : " --boot-id " + expected.bootId));
    }
}

internal sealed class WorkbenchWindow : Form
{
    private readonly DesktopRuntime runtime;
    private readonly bool noBrowser;
    private readonly Label state = new Label();
    private readonly Label address = new Label();
    private readonly Button open = new Button();
    private readonly Button stop = new Button();
    private readonly System.Windows.Forms.Timer awaken = new System.Windows.Forms.Timer();
    private DesktopRuntime.Instance instance;
    private bool busy, closing, canExit;

    public WorkbenchWindow(DesktopRuntime runtime, bool noBrowser, EventWaitHandle reopen)
    {
        this.runtime = runtime;
        this.noBrowser = noBrowser;
        Text = "知衡 · Agent 工作台";
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        ClientSize = new Size(470, 238);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = Color.FromArgb(248, 249, 252);
        var heading = new Label { Text = "知衡工作台", AutoSize = true, Left = 20, Top = 18,
            Font = new Font(Font.FontFamily, 17, FontStyle.Bold), ForeColor = Color.FromArgb(24, 43, 59) };
        state.SetBounds(22, 62, 425, 42);
        state.Text = "正在连接本地服务…";
        address.SetBounds(22, 105, 425, 24);
        var hint = new Label { Text = "关闭此窗口会停止本地服务；仅关闭浏览器标签可继续运行。",
            AutoSize = true, Left = 22, Top = 142, ForeColor = Color.FromArgb(72, 87, 100) };
        open.Text = "打开工作台";
        open.SetBounds(22, 183, 124, 34);
        open.Click += delegate { StartWorkspace(); };
        var data = new Button { Text = "打开数据目录" };
        data.SetBounds(156, 183, 131, 34);
        data.Click += delegate {
            try { Directory.CreateDirectory(runtime.Data); ShowInShell(runtime.Data); }
            catch (Exception error) { ShowFailure(error); }
        };
        stop.Text = "停止并退出";
        stop.SetBounds(327, 183, 119, 34);
        stop.Click += delegate { Close(); };
        Controls.AddRange(new Control[] { heading, state, address, hint, open, data, stop });
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (canExit) return;
            args.Cancel = true;
            closing = true;
            open.Enabled = stop.Enabled = false;
            if (!busy) StopAndClose();
        };
        Shown += delegate { StartWorkspace(); };
        awaken.Interval = 300;
        awaken.Tick += delegate {
            if (!reopen.WaitOne(0) || closing) return;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            if (!busy) StartWorkspace();
        };
        awaken.Start();
        FormClosed += delegate { awaken.Dispose(); };
    }

    private static void ShowInShell(string target)
    {
        using (Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })) { }
    }

    private void ShowFailure(Exception error)
    {
        state.Text = "操作未完成。可打开数据目录查看 server.log。";
        MessageBox.Show(this, error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private async void StartWorkspace()
    {
        if (busy || closing) return;
        busy = true;
        open.Enabled = false;
        state.Text = "正在确认本地工作台地址…";
        try {
            instance = await Task.Run(() => runtime.Start());
            state.Text = "本地服务已就绪";
            address.Text = instance.url;
            if (!closing && !noBrowser) ShowInShell(instance.url);
        } catch (Exception error) {
            if (!closing) ShowFailure(error);
        } finally {
            busy = false;
            open.Enabled = !closing;
            if (closing) StopAndClose();
        }
    }

    private async void StopAndClose()
    {
        if (busy) return;
        busy = true;
        state.Text = "正在停止本地服务…";
        try {
            if (instance != null) await Task.Run(() => runtime.Stop(instance));
            canExit = true;
            // This method can complete synchronously when startup failed. Never
            // re-enter the FormClosing event that requested the shutdown.
            BeginInvoke((Action)Close);
        } catch (Exception error) {
            closing = false;
            busy = false;
            open.Enabled = stop.Enabled = true;
            ShowFailure(error);
        }
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool headless = Array.IndexOf(args, "--start") >= 0 || Array.IndexOf(args, "--stop") >= 0;
        try {
            if (headless) {
                var utf8 = new UTF8Encoding(false);
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true });
                Console.SetError(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });
            }
            string mode = "", profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Zhiheng", "LogicKBAgent", "data");
            bool noBrowser = false;
            for (int i = 0; i < args.Length; i++) {
                if ((args[i] == "--start" || args[i] == "--stop") && mode == "") mode = args[i];
                else if (args[i] == "--no-browser") noBrowser = true;
                else if (args[i] == "--data-dir" && i + 1 < args.Length && Path.IsPathRooted(args[i + 1])) profile = args[++i];
                else throw new ArgumentException("参数：Zhiheng.exe [--start | --stop] [--data-dir 绝对路径] [--no-browser]");
            }
            var runtime = new DesktopRuntime(profile);
            if (mode == "--start") {
                Console.WriteLine(new JavaScriptSerializer().Serialize(runtime.Start()));
                return 0;
            }
            if (mode == "--stop") { runtime.Stop(null); return 0; }
            string identity;
            using (var sha = SHA256.Create())
                identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(runtime.Data.TrimEnd('\\').ToUpperInvariant()))).Replace("-", "");
            bool first;
            using (var reopen = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\Zhiheng-UI-" + identity, out first)) {
                if (!first) { reopen.Set(); return 0; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var window = new WorkbenchWindow(runtime, noBrowser, reopen)) Application.Run(window);
            }
            return 0;
        } catch (Exception error) {
            if (headless) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "知衡工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
