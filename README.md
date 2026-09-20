# ProxyPoolHub 🚀

轻量、高性能的多协议代理中继汇聚与本地 HTTP/SOCKS5 混合代理池调度管理平台。将多条远程节点（支持 VLESS Reality / Hysteria2 / VMess / Trojan / Shadowsocks 等）聚合转换为本地独立的固定 HTTP / SOCKS5 端口，提供现代化 WebUI 可视化控制台与 TOTP 二次验证保护。

---

## ✨ 核心特性

- 🌐 **多协议汇聚**: 支持主流代理协议一键导入并转为本地/公网固定的 `HTTP` 与 `SOCKS5` 混合监听端口。
- 🖥️ **Windows 专属桌面托盘**:
  - 零黑框后台静默常驻，屏幕右下角托盘便捷操控。
  - 右键一键开机自启动设置（写入当前用户注册表，无需复杂任务计划）。
  - 一键打开控制面板、启动/停止/重启服务。
- 🐧 **Linux / VPS 原生系统服务**:
  - 零 Docker 冗余，极低内存常驻（仅 30~50MB），消除了容器网络 NAT 开销与损耗。
  - 一键 Systemd 服务化，宕机与开机自动拉起守护。
  - 提供无损平滑更新脚本，配置与节点数据永不丢失。
- 🎨 **现代化 WebUI 管理面板**:
  - 实时连通性探测、出口 IP 与地理位置展示。
  - 毫秒级节点热开关（无需重启整个服务核心）。
  - 支持多选批量删除、剪贴板一键复制公网/内网代理地址。
- 🔐 **双因子工业级安全 (2FA / TOTP)**:
  - 支持 Google Authenticator / 微软 Authenticator 动态 6 位验证码。
  - 独立 6 格自动聚焦输入，支持动态码一键免密安全登录。

---

## 💻 Windows 快速上手

### 方式 A: 桌面托盘管理助手（推荐，无黑框静默运行）
1. 从 [**GitHub Releases 发布页**](https://github.com/yinSam612/ProxyPoolHub/releases) 下载最新的 **`ProxySocks5Tray.exe`** 置于项目根目录（或本地进入 `tray-windows/` 运行 `build-tray.bat` 自行编译）。
2. 双击运行 `ProxySocks5Tray.exe`，程序将自动在后台静默运行并常驻于屏幕右下角托盘，无任何 CMD 命令行黑框弹出。
3. 双击托盘图标，或右键选择 **【🌐 打开控制面板】** 即可直达管理网页（`http://127.0.0.1:3100`）。
4. 右键勾选 **【🚀 开机自动启动】**，即可随系统开机静默常驻。

### 方式 B: 命令行控制台运行
双击 `proxy.bat` 或在终端中执行：
```bat
:: 启动桌面托盘助手
proxy.bat tray

:: 或在前台查看控制台日志输出
proxy.bat web

:: 一键停止后台服务
proxy.bat stop
```

---

## 🐧 Linux / VPS 原生部署

推荐直接使用原生系统服务（Systemd / PM2），相比 Docker 资源占用更低、网络吞吐更直接。

### 1. 一键全自动部署
在 VPS 上克隆本仓库后，进入项目目录直接执行安装脚本：
```bash
git clone https://github.com/yinSam612/ProxyPoolHub.git /opt/proxypoolhub
cd /opt/proxypoolhub

# 执行一键自动化部署脚本（自动配置 Node.js、内核、依赖与 Systemd 常驻服务）
sudo bash deploy/install.sh
```

### 2. 常用运维命令
- 查看服务运行状态: `systemctl status proxy-socks5`
- 查看实时运行日志: `journalctl -u proxy-socks5 -f`
- 重启服务: `systemctl restart proxy-socks5`
- 停止服务: `systemctl stop proxy-socks5`

### 3. 平滑无损一键更新
当有新版本发布时，直接在项目目录下运行更新脚本：
```bash
sudo bash deploy/update.sh
```
> **安全承诺**: 更新脚本会自动保护现有的 `.env` 和 `data/proxies.json`，不会覆盖您的任何配置与节点。

---

## 🔗 与本机/同一 VPS 其它项目配合

同一台机器上运行的其他爬虫、Python 脚本或 Docker 容器无需经过公网，可直接通过本地内网连接对应的代理端口：
- **本机程序直接访问**: `127.0.0.1:40000` (HTTP / SOCKS5 混合支持)
- **同主机的 Docker 容器访问**: 直接通过宿主机默认网桥 IP `172.17.0.1:40000` 或 `host.docker.internal:40000` 直连，零网络延迟。

---

## 🛡️ 配置文件与开源隐私说明

本仓库已默认对所有个人敏感信息脱敏：
- `.env`: 环境变量与认证信息（请参考 `.env.example` 复制创建，已被 `.gitignore` 保护）。
- `data/proxies.json`: 个人节点配置信息（请参考 `data/proxies.json.example`，已被 `.gitignore` 保护）。

### 默认登录信息
- 默认 Web 地址: `http://服务器IP:3100`
- 默认管理员账号: `admin`
- 默认管理员密码: `admin888`（可在 `.env` 中通过 `ADMIN_PASSWORD` 自定义）
- 代理起始监听端口: `40000`
