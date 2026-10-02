# ProxyPoolHub 🚀

轻量的多协议代理汇聚与 HTTP/SOCKS5 混合代理池管理平台。支持导入 VLESS（含 Reality、RAW/TCP、WS、gRPC）、Hysteria2 和 Trojan 上游，映射为每个节点独立的 HTTP/SOCKS5、HY2 或 VLESS Reality 入口，提供 Web 控制台与 TOTP 二次验证。

---

## ✨ 功能特性

- 🌐 **多协议汇聚**: 支持主流代理协议节点导入，聚合映射为本地独立的 HTTP / SOCKS5 端口。
- 🖥️ **Windows 桌面托盘**:
  - 静默后台运行，任务栏托盘便捷控制。
  - 支持右键设置开机自启。
  - 一键打开 Web 控制台，支持免密直达。
- 🐧 **Linux / VPS 原生部署**:
  - 一键安装脚本，自动配置 Systemd 服务守护与开机自启。
  - 自动检测并放行系统防火墙端口（UFW / Firewalld）。
  - 安装完成后自动生成高强度随机密码并在终端打印。
  - 支持一键平滑更新，保留已有配置与节点。
- 🎨 **WebUI 控制台**:
  - 节点状态与出口 IP / 地理位置检测。
  - 节点启停自动重载内置核心，无需手动重启 Web 服务。
  - 支持节点多选批量管理与代理连接快速复制。
- 🔐🛡️ **双因子安全认证 (2FA / TOTP)**:
  - 支持标准 Authenticator 动态 6 位验证码。

---

## 💻 Windows 使用说明

### 桌面托盘版（推荐）
1. 从 [Releases 发布页](https://github.com/yinSam612/ProxyPoolHub/releases) 下载 `ProxySocks5Tray.exe` 置于项目根目录。
2. 运行 `ProxySocks5Tray.exe`，程序将常驻于右下角托盘。
3. 双击托盘图标（或右键点击 **【打开控制面板】**）即可进入管理面板（默认 `http://127.0.0.1:3100`）。
4. 右键勾选 **【开机自动启动】** 可随系统静默运行。

### 命令行运行
```bat
proxy.bat         :: 双击 proxy.bat 启动桌面托盘
proxy.bat web     :: 前台运行并查看控制台日志
proxy.bat stop    :: 停止后台服务
```

---

## 🐧 Linux / VPS 部署说明

### 1. 一键自动化安装
```bash
git clone https://github.com/yinSam612/ProxyPoolHub.git /opt/proxypoolhub
cd /opt/proxypoolhub
sudo bash deploy/install.sh
```
> 脚本安装完成后，终端会直接输出 Web 面板访问地址、随机生成的管理员密码与代理认证密码。

### 2. 日常维护
安装后可在任意目录使用短命令 `pph`，修改服务时会自动请求 sudo 权限：

| 命令 | 功能 |
| --- | --- |
| `pph` | 查看运行状态与自启动状态 |
| `pph logs` | 查看最近 100 行并持续跟踪日志，Ctrl+C 退出 |
| `pph restart` | 重启本项目，应用配置 |
| `pph stop` / `pph start` | 停止 / 启动本项目 |
| `pph update` | 从当前 Git 分支快进更新、安装依赖并重启 |
| `pph enable` | 重新注册服务、开启自启动并启动本项目 |
| `pph help` | 查看命令列表 |

`pph` 不管理服务器上其他 sing-box、xray 或 Nginx 服务。`pph stop` 只停止本次运行，不取消开机自启动。更新不会重置 `.env`、节点、Reality 密钥或 Web 修改后的密码；Git 存在冲突或非快进历史时会停止，避免自动合并。

### 3. 旧版本首次升级
旧版还没有 `pph` 时，在项目目录执行一次：
```bash
sudo bash deploy/update.sh
```
以后只需 `pph update`。安装和更新都会注册 Systemd 服务并启用开机自启动，等待网络就绪后启动 Web 和内置代理核心；程序退出后自动重启。非 Systemd 系统使用 PM2 的 `startup` 与 `save`，注册失败会报错，不会显示自启动成功。

### 4. 配置与备份
默认安装目录为 `/opt/proxypoolhub`。备份 `.env`、`data/proxies.json` 和 `runtime/acme`；数据文件中包含登录密码哈希、代理凭据和 Reality 私钥，不要公开。修改 `.env` 后执行 `pph restart`。节点与协议开关在 Web 保存即可生效。

---

## 🔗 代理端口与配合调用

- **本机 VPS 节点**: `39999/TCP`，通过本机网络出站；普通导入节点从 `40000/TCP` 开始，同时支持 HTTP 与 SOCKS5。
- **HY2 / VLESS**: 用于外部客户端接入，复制公网域名或 IP，不提供本机或 Docker 版本。HY2 与对应节点 HTTP/SOCKS5 同号，使用 UDP。VLESS + RAW + Reality 使用独立 TCP 端口，从 `50000` 开始自动分配，默认范围 `50000-50100`。
- **HTTP / SOCKS5**: 主要用于 VPS 本机和 Docker，也可对外开放。节点行 HTTP/SOCKS5 默认复制 `127.0.0.1` 的认证地址；“更多”或“复制所选 → 外部使用”提供公网地址。“复制所选”也可批量复制已开启的 HY2 和 VLESS Reality 公网连接。
- **同机 Docker 项目**: 节点行“更多”可复制 Docker HTTP/SOCKS5 地址，工具栏“Docker”支持批量复制和 Compose 配置气泡。地址使用短主机别名 `host`，包含认证信息及该节点端口，不使用容器自身的 `127.0.0.1`。

在需要使用代理的现有 Compose 服务内合并以下片段（面板气泡可一键复制）：

```yaml
    extra_hosts:
      - "host:host-gateway"
```

`host` 是宿主机的短主机别名，不是新建的 Docker 网络；保留其他项目原有网络配置即可。此配置用于同一台宿主机上的普通 Bridge 网络容器，Docker Engine 需支持 `host-gateway`。宿主机代理须监听 Docker 可访问的地址（VPS 安装默认 `0.0.0.0`），并允许 Docker 网段访问。其他服务器上的容器应使用公网代理地址；使用 Host 网络的容器可直接使用面板的“本机 HTTP/SOCKS5”地址。

## 节点 HY2 中转出口

安装后首个节点为自身 VPS，名称使用系统主机名（例如 `vps-demo`），使用 `39999` 端口，通过本机网络直接出站。该节点不能删除或修改，可以禁用；同样可开启同号端口的 HY2。自身 HY2/VLESS 的链接备注使用 `主机名:出口IP-国家代码`，不再使用“本机 VPS”；导入节点保留用户设定的名称。

节点列表的“导出节点”下载普通节点的 JSON（名称、原始链接、启用状态），在其他服务器的“批量导入”中选择该文件即可合并导入。重复链接会跳过，端口由目标服务器重新分配，本机节点不会迁移；HY2 和 Reality 中转入口需在目标服务器重新配置。导出文件含上游代理凭据，请妥善保管，不包含 Web 登录密码、证书路径、Reality 私钥或订阅令牌。

1. 将公网域名的 A 记录（如有 AAAA 也一并）指向 VPS-A，确保公网 TCP 443 可访问且没有其他程序占用。域名使用 Cloudflare 时不要开启代理（灰云直连）。HY2 与节点 HTTP/SOCKS5 使用相同端口号，HTTP/SOCKS5 使用 TCP，HY2 使用 UDP；证书验证走 TCP 443。
2. 登录 Web 面板，顶部“HY2 设置”保存证书配置，再在节点行点击“HY2 +”开启该节点的 HY2。每个节点最多一个 HY2，重复开启不会新增出口或更换密码。自动模式使用 Let's Encrypt 申请证书并在运行期间续期，证书存放在 `runtime/acme`；在面板看到“证书已签发”后才可连接。已有证书模式填写证书和私钥在 **VPS-A 上的绝对路径**，证书须有效且私钥匹配。项目不会接管 VPS 上已有的 xray/sing-box 服务。
3. 点击节点行的“HY2”或设置弹窗的复制按钮，获取带 `#名称:出口IP-国家代码` 备注的 `hysteria2://` 链接。流量先到 VPS-A，再通过该导入节点出站，与节点 HTTP/SOCKS5 的出口相同，不使用 VPS-A 的 `direct`。节点停用时 HY2 同时停用，重新启用后恢复；删除节点（含批量删除）会一并删除其 HY2。旧版已关联 HY2 会自动迁移到节点同号端口并保留密码，客户端须重新复制链接；未关联的旧记录不会转发，只能删除。
4. 安装或更新脚本会放行本机 UFW/Firewalld 的 `443/tcp` 和节点端口范围的 TCP/UDP（默认 `40000-40100`）；如使用云厂商安全组，也需分别放行 TCP、UDP。若 TCP 443 已被 Nginx 等服务占用，自动模式无法使用，请选择已有证书方式。请持久化并备份 `runtime/acme`，不要删除证书和账户密钥。自行签发的证书需在客户端配置可信证书，不要为了绕过验证开启 `insecure`。

## 节点 VLESS + RAW + Reality 中转

1. 在需要的节点行点击 **VLESS +**（已有入口可从“更多 → Reality 设置”修改）。填写 VPS-A 的公网 IPv4 或直连域名，以及 VPS-A 可访问、支持 TLS 1.3 且兼容 Reality 的目标域名 / SNI，默认 `www.apple.com`。普通 HTTPS/TLS 1.3 探测成功不代表 Reality 握手一定成功；连接失败时需检查目标兼容性。不需要自行申请或续期证书；目标域名不是管理面板域名，不需要归你所有。
2. 保存后自动分配独立 TCP 端口（从 `50000` 起，跳过已占用端口），并生成 UUID、X25519 密钥和 short ID。重复保存、禁用或重启不会更换密钥、UUID 和端口。开启的节点可直接点击 **VLESS** 复制 `vless://...type=raw&security=reality&flow=xtls-rprx-vision...#名称:出口IP-国家代码`。
3. 每个节点最多一个 Reality 入口，路由绑定该节点出站；本机 VPS 节点走本机直连，导入节点走对应上游。禁用节点时所有入口同步停止，重新启用后恢复；Reality 也可单独停用或删除，不影响该节点的 HTTP/SOCKS5/HY2。
4. 安装和更新会放行 UFW/Firewalld 的 `50000-50100/TCP`，云厂商安全组需单独放行。Reality 不经过 Nginx 的 HTTP 反向代理或 Cloudflare 橙云；填写域名时用灰云 DNS，或直接填公网 IP。RAW 即原始 TCP 传输，导入上游兼容 `type=raw` 和旧版 `type=tcp`。

## 管理安全

Web 面板“修改密码”可轮换管理员密码：新密码至少 12 位，须含大小写字母、数字和符号，修改后所有已登录会话失效。原 `.env` 密码不再可用于登录；轮换后的密码以哈希形式保存在代理数据文件（默认 `data/proxies.json`）中，重启仍有效。已有密码不会自动被更改。

VPS 上的 Web 面板默认仍是 HTTP；公网管理请使用 HTTPS 反向代理或 SSH 隧道，避免在网络中明文发送管理员密码。
