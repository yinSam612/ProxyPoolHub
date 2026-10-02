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
  - nftables 访问控制：本机 / Docker 代理默认不对公网开放，HY2 / Reality 按启用状态开放。
  - 安装完成后自动生成高强度随机密码并在终端打印。
  - 支持一键平滑更新，保留已有配置与节点。
- 🎨 **WebUI 控制台**:
  - 节点状态与出口 IP / 地理位置检测。
  - 节点启停自动重载内置核心，无需手动重启 Web 服务。
  - 支持节点多选批量管理与代理连接快速复制。
- 🔐🛡️ **双因子安全认证 (2FA / TOTP)**:
  - 启用后必须同时验证密码与 Authenticator 动态码，不能单靠密码、验证码或 Basic 认证绕过。
  - 网页和 API 密码认证统一限速，敏感操作重新验证身份。

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
> 脚本安装完成后，终端输出随机管理员密码和代理密码。Web 默认仅允许本机访问，可先用 SSH 隧道进入：`ssh -L 3100:127.0.0.1:3100 用户@VPS`，然后打开 `http://127.0.0.1:3100`。SSH 使用自定义端口时追加 `-p 端口`。

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
- **HTTP / SOCKS5**: 主要用于 VPS 本机和 Docker，也可按来源规则对外开放。列表上方的复制场景选择“本机 / Docker / 公网”，同时影响行内 HTTP/SOCKS5 和“复制所选”；默认复制本机 `127.0.0.1`。防火墙未开放公网 TCP 时，公网选项不可用；未托管防火墙的部署显示“公网访问未核验”，复制地址不代表公网可达。HY2 和 VLESS 始终复制公网连接，不受场景切换影响。
- **同机 Docker 项目**: 将复制场景切换到“Docker”，工具栏“Docker”也支持批量复制和 Compose 配置气泡。地址使用短主机别名 `host`，包含认证信息及该节点端口，不使用容器自身的 `127.0.0.1`。节点“更多 → 节点设置”集中管理 HY2、VLESS 和凭据重置。

在需要使用代理的现有 Compose 服务内合并以下片段（面板气泡可一键复制）：

```yaml
    extra_hosts:
      - "host:host-gateway"
```

`host` 是宿主机的短主机别名，不是新建的 Docker 网络；保留其他项目原有网络配置即可。此配置用于同一台宿主机上的普通 Bridge 网络容器，Docker Engine 需支持 `host-gateway`。VPS 安装默认监听 `0.0.0.0`，访问控制自动允许本机与现有 Docker Bridge 网段，拒绝其他来源的 HTTP/SOCKS5。创建新 Docker 网络后执行 `pph restart` 刷新网段。其他服务器优先用 HY2/VLESS；确需公网 HTTP/SOCKS5 时先配置来源白名单。Host 网络容器可使用面板的“本机 HTTP/SOCKS5”地址。

## 节点 HY2 中转出口

安装后首个节点为自身 VPS，名称使用系统主机名（例如 `vps-demo`），使用 `39999` 端口，通过本机网络直接出站。该节点不能删除或修改，可以禁用；同样可开启同号端口的 HY2。自身 HY2/VLESS 的链接备注使用 `主机名:出口IP-国家代码`，不再使用“本机 VPS”；导入节点保留用户设定的名称。

节点列表的“导出节点”下载普通节点的 JSON（名称、原始链接、启用状态），在其他服务器的“批量导入”中选择该文件即可合并导入。重复链接会跳过，端口由目标服务器重新分配，本机节点不会迁移；HY2 和 Reality 中转入口需在目标服务器重新配置。导出文件含上游代理凭据，请妥善保管，不包含 Web 登录密码、证书路径、Reality 私钥或订阅令牌。

1. 将公网域名的 A 记录（如有 AAAA 也一并）指向 VPS-A，确保公网 TCP 443 可访问且没有其他程序占用。域名使用 Cloudflare 时不要开启代理（灰云直连）。HY2 与节点 HTTP/SOCKS5 使用相同端口号，HTTP/SOCKS5 使用 TCP，HY2 使用 UDP；证书验证走 TCP 443。
2. 登录 Web 面板，顶部“设置 → HY2 设置”保存证书配置，再在节点“更多 → 节点设置”开启该节点的 HY2。每个节点最多一个 HY2，重复开启不会新增出口或更换密码。自动模式使用 Let's Encrypt 申请证书并在运行期间续期，证书存放在 `runtime/acme`；在面板看到“证书已签发”后才可连接。已有证书模式填写证书和私钥在 **VPS-A 上的绝对路径**，证书须有效且私钥匹配。项目不会接管 VPS 上已有的 xray/sing-box 服务。
3. 点击节点行的“HY2”或设置弹窗的复制按钮，获取带 `#名称:出口IP-国家代码` 备注的 `hysteria2://` 链接。流量先到 VPS-A，再通过该导入节点出站，与节点 HTTP/SOCKS5 的出口相同，不使用 VPS-A 的 `direct`。节点停用时 HY2 同时停用，重新启用后恢复；删除节点（含批量删除）会一并删除其 HY2。旧版已关联 HY2 会自动迁移到节点同号端口并保留密码，客户端须重新复制链接；未关联的旧记录不会转发，只能删除。
4. 安装或更新配置基础防火墙许可；前置 `pph_security` 规则只允许已启用 HY2 的 UDP 端口，其他同号 TCP 仍仅本机 / Docker / 指定来源可用。云厂商安全组需单独放行已启用端口。若 TCP 443 已被 Nginx 等服务占用，自动模式无法使用，请选择已有证书方式。请持久化并备份 `runtime/acme`，不要删除证书和账户密钥。自行签发的证书需在客户端配置可信证书，不要为了绕过验证开启 `insecure`。

## 节点 VLESS + RAW + Reality 中转

1. 在需要的节点行打开“更多 → 节点设置”，点击 **VLESS / Reality** 的设置按钮；已有入口可点击该行齿轮修改参数。填写 VPS-A 的公网 IPv4 或直连域名，以及 VPS-A 可访问、支持 TLS 1.3 且兼容 Reality 的目标域名 / SNI，默认 `www.apple.com`。普通 HTTPS/TLS 1.3 探测成功不代表 Reality 握手一定成功；连接失败时需检查目标兼容性。不需要自行申请或续期证书；目标域名不是管理面板域名，不需要归你所有。
2. 保存后自动分配独立 TCP 端口（从 `50000` 起，跳过已占用端口），并生成 UUID、X25519 密钥和 short ID。重复保存、禁用或重启不会更换密钥、UUID 和端口。开启的节点可直接点击 **VLESS** 复制 `vless://...type=raw&security=reality&flow=xtls-rprx-vision...#名称:出口IP-国家代码`。
3. 每个节点最多一个 Reality 入口，路由绑定该节点出站；本机 VPS 节点走本机直连，导入节点走对应上游。禁用节点时所有入口同步停止，重新启用后恢复。在“节点设置”的 VLESS 行可直接单独启停，停用保留端口、UUID 和密钥；也可进入参数设置删除入口，HTTP/SOCKS5/HY2 配置不变。协议变更会重载核心，已有连接可能断开。
4. 前置访问控制只开放已启用 Reality 的 TCP 端口，未启用端口关闭；云厂商安全组需单独放行。Reality 不经过 Nginx 的 HTTP 反向代理或 Cloudflare 橙云；填写域名时用灰云 DNS，或直接填公网 IP。RAW 即原始 TCP 传输，导入上游兼容 `type=raw` 和旧版 `type=tcp`。

## 管理安全

Web 面板“修改密码”可轮换管理员密码：新密码至少 12 位，须含大小写字母、数字和符号，修改后所有已登录会话失效。原 `.env` 密码不再可用于登录；轮换后的密码以哈希形式保存在代理数据文件（默认 `data/proxies.json`）中，重启仍有效。已有密码不会自动被更改。

### HTTPS 反代与来源限制

正式 VPS 安装强制认证，Web 默认仅本机可访问，不再通过公网 IP 直连 `3100`。NPM 在 Docker 中时，在 `.env` 配置实际反代容器 IP，然后 `pph restart`：

```dotenv
WEB_HOST=0.0.0.0
TRUSTED_PROXY_CIDRS=172.18.0.2/32
WEB_ALLOWED_CIDRS=127.0.0.1/32,::1/128
MANAGE_FIREWALL=true
REQUIRE_AUTH=true
```

反代来源会自动加入 Web 允许列表；`TRUSTED_PROXY_CIDRS` 只能填写受信任反代的地址，不能填写 `0.0.0.0/0`。NPM 转发目标使用宿主机可访问地址（如 `172.17.0.1:3100`），为公网域名启用 HTTPS。反代容器 IP 变化时同步更新配置。直接访问的请求不能伪造 `X-Real-IP` 绕过认证限速；不受信任的 `X-Forwarded-Proto` 也不会影响安全 Cookie。

HTTP/SOCKS5 默认仅本机与 Docker 可用。确需允许固定公网来源时设置 `PROXY_EXTERNAL_CIDRS=203.0.113.8/32,2001:db8::8/128` 并执行 `pph restart`；请替换为自己的实际来源，不要开放所有地址。普通 HTTP/SOCKS5 认证不提供链路加密，公网优先使用 HY2/VLESS 或加密隧道。

访问控制使用独立的 nftables `inet pph_security` 表，不刷新整台 VPS 的规则，也不修改 SSH、NPM、其他服务的规则；包含 IPv4/IPv6，并在服务启动和节点 / 协议变更时原子更新。UFW/Firewalld 可能仍显示托管端口范围许可，实际公网访问还受此前置表限制，可用 `sudo nft list table inet pph_security` 查看。不要手动执行 `nft flush ruleset`；改动防火墙或 Docker 网络后执行 `pph restart` 重新校验。防火墙配置失败时不会启动代理核心。

### 双重验证与凭据撤销

在 Web 身份验证器中输入当前密码、扫码并验证动态码后开启双重验证；所有旧会话失效，之后登录必须同时提供密码和动态码。验证码不能重复用于登录。停用 / 重新绑定验证器、修改管理密码、更换代理凭据和轮换订阅 Token 都要重新验证身份；已启用的 TOTP 密钥不会再由设置接口返回。保持手机时间同步并妥善保存首次绑定密钥。

网页登录与 Basic 密码认证共享每来源 10 分钟最多 10 次未成功验证的限制，另有跨来源渐进退避；返回 `429` 和 `Retry-After` 时需等待。启用双重验证后 Basic 认证不可用，脚本可使用独立订阅 Token 获取 HTTP/SOCKS5 列表。限速状态属于当前单进程，重启会清空，不是分布式限速服务；不能代替强密码或防护大流量 DDoS。

节点“更多 → 节点设置”的敏感操作区提供 **重置 HY2 凭据 / 重置 VLESS 凭据**，VLESS 设置也可重置。仅在确认并重新验证身份后更换密码 / UUID / Reality 密钥，端口、名称和绑定出口保持不变，旧连接凭据失效；重置会重载核心并断开已有连接。更新不会自动轮换任何凭据。访问设置可生成随机代理密码，更换后所有使用旧 HTTP/SOCKS5 账号密码的配置须同步更新；新代理密码至少 16 位，须含大小写字母、数字和符号，不超过 SOCKS5 的 255 字节上限。
