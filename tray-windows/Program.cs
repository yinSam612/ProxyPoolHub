using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ProxySocks5Tray;

/// <summary>
/// Proxy-SOCKS5 桌面托盘管理助手
/// 提供后台静默无黑框运行、系统托盘常驻、一键开机自启动配置与快捷操作
/// </summary>
static class Program
{
    private const string AppName = "ProxySocks5Tray";
    private const string RunRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static NotifyIcon? _trayIcon;
    private static ContextMenuStrip? _trayMenu;
    private static ToolStripMenuItem? _statusItem;
    private static ToolStripMenuItem? _toggleServerItem;
    private static ToolStripMenuItem? _restartServerItem;
    private static ToolStripMenuItem? _autoStartItem;

    private static Process? _nodeProcess;
    private static string _appDir = "";
    private static string _serverJsPath = "";
    private static int _webPort = 3100;

    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();

        // 确保单实例运行，避免重复启动
        using var mutex = new System.Threading.Mutex(true, "ProxySocks5Tray_SingleInstance_Mutex", out bool isFirstInstance);
        if (!isFirstInstance)
        {
            MessageBox.Show("Proxy-SOCKS5 托盘助手已在运行中，请查看右下角系统托盘！", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        InitPaths();
        ParseWebPort();

        // 初始化托盘菜单和图标
        InitTray();

        // 启动后台 Node 服务
        StartNodeServer();
        _trayIcon?.ShowBalloonTip(3000, "ProxyPoolHub", "托盘已启动，请查看右下角通知区域。", ToolTipIcon.Info);

        // 运行消息循环
        Application.Run();
    }

    /// <summary>
    /// 初始化工作目录与关键文件路径
    /// </summary>
    private static void InitPaths()
    {
        // 若从 tray-windows 子目录或发布目录运行，寻找包含 server.js 的根目录
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        if (File.Exists(Path.Combine(baseDir, "server.js")))
        {
            _appDir = baseDir;
        }
        else if (File.Exists(Path.Combine(baseDir, "..", "server.js")))
        {
            _appDir = Path.GetFullPath(Path.Combine(baseDir, ".."));
        }
        else if (File.Exists(Path.Combine(baseDir, "..", "..", "server.js")))
        {
            _appDir = Path.GetFullPath(Path.Combine(baseDir, "..", ".."));
        }
        else
        {
            _appDir = baseDir;
        }

        _serverJsPath = Path.Combine(_appDir, "server.js");
    }

    /// <summary>
    /// 从 .env 中解析 WEB_PORT 端口，默认 3100
    /// </summary>
    private static void ParseWebPort()
    {
        try
        {
            string envPath = Path.Combine(_appDir, ".env");
            if (File.Exists(envPath))
            {
                foreach (var line in File.ReadAllLines(envPath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.StartsWith("WEB_PORT=", StringComparison.OrdinalIgnoreCase))
                    {
                        var val = trimmed.Substring("WEB_PORT=".Length).Trim();
                        if (int.TryParse(val, out int p) && p > 0)
                        {
                            _webPort = p;
                            break;
                        }
                    }
                }
            }
        }
        catch
        {
            _webPort = 3100;
        }
    }

    /// <summary>
    /// 初始化系统托盘组件、菜单项及事件响应
    /// </summary>
    private static void InitTray()
    {
        _trayMenu = new ContextMenuStrip();

        // 1. 状态展示项 (只读)
        _statusItem = new ToolStripMenuItem("服务状态: 正在启动...") { Enabled = false };
        _trayMenu.Items.Add(_statusItem);
        _trayMenu.Items.Add(new ToolStripSeparator());

        // 2. 打开管理后台
        var openWebItem = new ToolStripMenuItem("🌐 打开控制面板", null, (s, e) => OpenWebAdmin());
        openWebItem.Font = new Font(openWebItem.Font, FontStyle.Bold);
        _trayMenu.Items.Add(openWebItem);

        _trayMenu.Items.Add(new ToolStripSeparator());

        // 3. 服务控制项: 启动 / 停止 / 重启
        _toggleServerItem = new ToolStripMenuItem("⏹ 停止服务", null, (s, e) => ToggleServer());
        _restartServerItem = new ToolStripMenuItem("🔄 重启服务", null, (s, e) => RestartServer());
        _trayMenu.Items.Add(_toggleServerItem);
        _trayMenu.Items.Add(_restartServerItem);

        _trayMenu.Items.Add(new ToolStripSeparator());

        // 4. 开机自启动设置项 (带复选框)
        _autoStartItem = new ToolStripMenuItem("🚀 开机自动启动") { CheckOnClick = true };
        _autoStartItem.Checked = IsAutoStartEnabled();
        _autoStartItem.Click += (s, e) => ToggleAutoStart();
        _trayMenu.Items.Add(_autoStartItem);

        // 5. 打开程序与数据目录
        var openFolderItem = new ToolStripMenuItem("📁 打开程序目录", null, (s, e) => OpenFolder());
        _trayMenu.Items.Add(openFolderItem);

        _trayMenu.Items.Add(new ToolStripSeparator());

        // 6. 退出程序
        var exitItem = new ToolStripMenuItem("❌ 退出助手", null, (s, e) => ExitApp());
        _trayMenu.Items.Add(exitItem);

        // 加载高质量科技网络中继图标
        Icon appIcon = CreateTechRelayIcon(false);

        _trayIcon = new NotifyIcon
        {
            Icon = appIcon,
            ContextMenuStrip = _trayMenu,
            Text = "ProxyPoolHub 桌面管理助手",
            Visible = true
        };

        // 双击托盘图标直接打开控制面板网页
        _trayIcon.DoubleClick += (s, e) => OpenWebAdmin();
    }

    /// <summary>
    /// 以完全无黑框模式在后台拉起 Node.js 服务
    /// </summary>
    private static void StartNodeServer()
    {
        if (_nodeProcess != null && !_nodeProcess.HasExited)
        {
            UpdateStatus(true);
            return;
        }

        if (!File.Exists(_serverJsPath))
        {
            MessageBox.Show($"未找到 server.js 文件: {_serverJsPath}", "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            UpdateStatus(false);
            return;
        }

        try
        {
            string runtimeDir = Path.Combine(_appDir, "runtime");
            Directory.CreateDirectory(runtimeDir);
            string logPath = Path.Combine(runtimeDir, "tray.log");

            var startInfo = new ProcessStartInfo
            {
                FileName = "node.exe",
                Arguments = $"\"{_serverJsPath}\"",
                WorkingDirectory = _appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            _nodeProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };

            // 异步重定向输出到日志文件
            _nodeProcess.OutputDataReceived += (s, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    try { File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {e.Data}{Environment.NewLine}"); } catch { }
                }
            };
            _nodeProcess.ErrorDataReceived += (s, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                {
                    try { File.AppendAllText(logPath, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss} ERROR] {e.Data}{Environment.NewLine}"); } catch { }
                }
            };

            _nodeProcess.Exited += (s, e) =>
            {
                UpdateStatus(false);
            };

            _nodeProcess.Start();
            _nodeProcess.BeginOutputReadLine();
            _nodeProcess.BeginErrorReadLine();

            UpdateStatus(true);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"启动 Node 服务失败: {ex.Message}\n请确保系统已安装 Node.js 并已加入 PATH 环境变量。", "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            UpdateStatus(false);
        }
    }

    /// <summary>
    /// 停止后台 Node 进程及其衍生子进程
    /// </summary>
    private static void StopNodeServer()
    {
        if (_nodeProcess != null)
        {
            try
            {
                if (!_nodeProcess.HasExited)
                {
                    // 杀死进程树以保证 sing-box 进程一并退出
                    _nodeProcess.Kill(entireProcessTree: true);
                    _nodeProcess.WaitForExit(3000);
                }
            }
            catch { }
            finally
            {
                _nodeProcess.Dispose();
                _nodeProcess = null;
            }
        }
        UpdateStatus(false);
    }

    /// <summary>
    /// 切换启动/停止服务
    /// </summary>
    private static void ToggleServer()
    {
        if (_nodeProcess != null && !_nodeProcess.HasExited)
        {
            StopNodeServer();
        }
        else
        {
            StartNodeServer();
        }
    }

    /// <summary>
    /// 重启服务
    /// </summary>
    private static void RestartServer()
    {
        StopNodeServer();
        System.Threading.Thread.Sleep(500);
        StartNodeServer();
    }

    /// <summary>
    /// 更新托盘菜单项文字与运行状态
    /// </summary>
    private static void UpdateStatus(bool isRunning)
    {
        if (_trayMenu != null && _trayMenu.IsHandleCreated)
        {
            _trayMenu.BeginInvoke(new Action(() => ApplyStatus(isRunning)));
        }
        else
        {
            ApplyStatus(isRunning);
        }
    }

    private static void ApplyStatus(bool isRunning)
    {
        if (_statusItem != null)
        {
            _statusItem.Text = isRunning ? "服务状态: 运行中 🟢" : "服务状态: 已停止 ⏹";
        }
        if (_toggleServerItem != null)
        {
            _toggleServerItem.Text = isRunning ? "⏹ 停止服务" : "▶ 启动服务";
        }
        if (_restartServerItem != null)
        {
            _restartServerItem.Enabled = isRunning;
        }
        if (_trayIcon != null)
        {
            _trayIcon.Icon = CreateTechRelayIcon(isRunning);
            _trayIcon.Text = isRunning ? $"ProxyPoolHub: 运行中 (:{_webPort})" : "ProxyPoolHub: 已停止";
        }
    }

    /// <summary>
    /// 在系统默认浏览器中打开控制面板
    /// </summary>
    private static void OpenWebAdmin()
    {
        try
        {
            string url = $"http://127.0.0.1:{_webPort}";
            Process.Start(new ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"打开浏览器失败: {ex.Message}", "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// 打开程序所在目录
    /// </summary>
    private static void OpenFolder()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = _appDir,
                UseShellExecute = true
            });
        }
        catch { }
    }

    /// <summary>
    /// 检测当前程序是否已注册开机启动
    /// </summary>
    private static bool IsAutoStartEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, false);
            return key?.GetValue(AppName) != null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 切换开机自动启动状态（写入或移除注册表 Run 键）
    /// </summary>
    private static void ToggleAutoStart()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunRegistryKey, true);
            if (key == null) return;

            if (_autoStartItem != null && _autoStartItem.Checked)
            {
                // 写入当前 exe 完整路径
                string exePath = Process.GetCurrentProcess().MainModule?.FileName ?? Application.ExecutablePath;
                key.SetValue(AppName, $"\"{exePath}\"");
                _trayIcon?.ShowBalloonTip(2000, "开机启动已开启", "系统开机登录时将自动在后台启动托盘管理助手。", ToolTipIcon.Info);
            }
            else
            {
                // 从注册表移除
                key.DeleteValue(AppName, false);
                _trayIcon?.ShowBalloonTip(2000, "开机启动已关闭", "已取消开机自动启动。", ToolTipIcon.Info);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"修改开机自启动设置失败: {ex.Message}", "权限提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>
    /// 退出托盘助手，安全结束关联的 Node 进程
    /// </summary>
    private static void ExitApp()
    {
        StopNodeServer();
        if (_trayIcon != null)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
        }
        Application.Exit();
    }

    /// <summary>
    /// 动态绘制科技感网络中继立体拓扑图标，中心展示节点与发光连线
    /// </summary>
    /// <param name="isRunning">当前后台服务是否处于运行状态</param>
    /// <returns>高品质 Icon 对象</returns>
    private static Icon CreateTechRelayIcon(bool isRunning)
    {
        const int size = 32;
        using var bmp = new Bitmap(size, size);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

        // 背景：深色科技圆角微底板
        using var path = new System.Drawing.Drawing2D.GraphicsPath();
        const int r = 7;
        path.AddArc(1, 1, r, r, 180, 90);
        path.AddArc(size - 2 - r, 1, r, r, 270, 90);
        path.AddArc(size - 2 - r, size - 2 - r, r, r, 0, 90);
        path.AddArc(1, size - 2 - r, r, r, 90, 90);
        path.CloseFigure();

        using (var bgBrush = new System.Drawing.Drawing2D.LinearGradientBrush(
            new Point(0, 0), new Point(size, size),
            Color.FromArgb(15, 23, 42), Color.FromArgb(30, 41, 59)))
        {
            g.FillPath(bgBrush, path);
        }

        // 外边框微发光
        Color borderColor = isRunning ? Color.FromArgb(56, 189, 248) : Color.FromArgb(71, 85, 105);
        using (var borderPen = new Pen(borderColor, 1.5f))
        {
            g.DrawPath(borderPen, path);
        }

        // 连线拓扑（三节点网络互联）
        Color lineColor = isRunning ? Color.FromArgb(147, 197, 253) : Color.FromArgb(100, 116, 139);
        using (var linePen = new Pen(lineColor, 1.6f))
        {
            g.DrawLine(linePen, 8, 22, 16, 9);
            g.DrawLine(linePen, 16, 9, 24, 22);
            g.DrawLine(linePen, 8, 22, 24, 22);
        }

        // 顶部核心节点（运行中发光翡翠绿，停止时灰白）
        Color coreColor = isRunning ? Color.FromArgb(52, 211, 153) : Color.FromArgb(148, 163, 184);
        using (var coreBrush = new SolidBrush(coreColor))
        {
            g.FillEllipse(coreBrush, 13, 6, 6, 6);
        }

        // 左下入站节点（科技天蓝）
        Color inColor = isRunning ? Color.FromArgb(56, 189, 248) : Color.FromArgb(100, 116, 139);
        using (var inBrush = new SolidBrush(inColor))
        {
            g.FillEllipse(inBrush, 5, 19, 6, 6);
        }

        // 右下出站节点（活力粉紫）
        Color outColor = isRunning ? Color.FromArgb(244, 114, 182) : Color.FromArgb(100, 116, 139);
        using (var outBrush = new SolidBrush(outColor))
        {
            g.FillEllipse(outBrush, 21, 19, 6, 6);
        }

        return Icon.FromHandle(bmp.GetHicon());
    }
}
