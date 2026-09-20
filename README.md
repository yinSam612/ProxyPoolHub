# ProxyPoolHub

轻量、高性能的多协议代理汇聚与本地 HTTP/SOCKS5 混合代理池调度管理平台。支持将多条远程节点（VLESS Reality / Hysteria2 / VMess / Trojan / Shadowsocks 等）聚合转换为独立的本地/内网固定 HTTP 与 SOCKS5 端口，并提供 Web 可视化控制台与 TOTP 二次验证保护。

---

## 功能特性

- **多协议汇聚**: 支持主流代理协议节点导入，聚合映射为本地独立的 HTTP / SOCKS5 端口。
- **Windows 桌面托盘**:
  - 静默后台运行，任务栏托盘便捷控制。
  - 支持右键设置开机自启。
  - 一键打开 Web 控制台，支持免密直达。
- **Linux / VPS 原生部署**:
  - 一键安装脚本，自动配置 Systemd 服务守护与开机自启。
  - 安装完成后自动生成高强度随机密码并在终端打印。
  - 支持一键平滑更新，保留已有配置与节点。
- **WebUI 控制台**:
  - 节点状态与出口 IP / 地理位置检测。
  - 毫秒级节点热开关（无需重启服务）。
  - 支持节点多选批量管理与代理连接快速复制。
- **双因子安全认证 (2FA / TOTP)**:
  - 支持标准 Authenticator 动态 6 位验证码。

---

## Windows 使用说明

### 桌面托盘版（推荐）
1. 从 [Releases 发布页](https://github.com/yinSam612/ProxyPoolHub/releases) 下载 `ProxySocks5Tray.exe` 置于项目根目录。
2. 运行 `ProxySocks5Tray.exe`，程序将常驻于右下角托盘。
3. 双击托盘图标（或右键点击 **【打开控制面板】**）即可进入管理面板（默认 `http://127.0.0.1:3100`）。
4. 右键勾选 **【开机自动启动】** 可随系统静默运行。

### 命令行运行
```bat
proxy.bat tray    :: 启动桌面托盘
proxy.bat web     :: 前台运行并查看控制台日志
proxy.bat stop    :: 停止后台服务
```

---

## Linux / VPS 部署说明

### 1. 一键自动化安装
```bash
git clone https://github.com/yinSam612/ProxyPoolHub.git /opt/proxypoolhub
cd /opt/proxypoolhub
sudo bash deploy/install.sh
```
> 脚本安装完成后，终端会直接输出 Web 面板访问地址、随机生成的管理员密码与代理认证密码。

### 2. 常用管理命令
- 查看状态: `systemctl status proxypoolhub`
- 查看日志: `journalctl -u proxypoolhub -f`
- 重启服务: `systemctl restart proxypoolhub`
- 停止服务: `systemctl stop proxypoolhub`

### 3. 平滑更新
```bash
sudo bash deploy/update.sh
```

---

## 代理端口与配合调用

- **代理起始端口**: 默认从 `40000` 开始（每个节点对应一个独立端口，同时支持 HTTP 与 SOCKS5 协议）。
- **本机程序直连**: `127.0.0.1:40000`
- **Docker 容器调用宿主机代理**: 可直接配置 `host.docker.internal:40000` 或宿主机网桥 IP `172.17.0.1:40000`。
