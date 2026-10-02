# ProxyPoolHub

将多台 VPS 的代理集中到一台服务器管理。支持导入 VLESS、HY2、Trojan 上游，为每个节点提供独立的 HTTP/SOCKS5、HY2 和 VLESS Reality 入口。项目自行管理 sing-box 核心，无需另装代理服务。

## VPS 安装

在已安装 Git 的 VPS 上，以 root 执行：

```bash
git clone https://github.com/yinSam612/ProxyPoolHub.git /opt/proxypoolhub
cd /opt/proxypoolhub
bash deploy/install.sh
```

首次安装会要求设置管理员用户名，并自动生成强密码。安装后开机自启，终端显示登录信息；重复安装保留原账号。非交互安装可用 `ADMIN_USER=你的用户名 bash deploy/install.sh`。

## 登录面板

默认不开放公网 `3100`。在自己的电脑上建立 SSH 隧道，替换 `VPS_IP`：

```bash
ssh -L 3100:127.0.0.1:3100 root@VPS_IP
```

打开 `http://127.0.0.1:3100`，使用安装时显示的账号密码登录。SSH 使用非默认端口时，在命令中加 `-p 端口`。

### 使用域名访问（可选）

可按需使用 HTTPS 反向代理，转发到本项目的 `3100` 端口。在 `.env` 的 `TRUSTED_PROXY_CIDRS` 中填写实际反代来源 IP/CIDR；跨容器或服务器连接时，按需调整 `WEB_HOST`。修改后执行 `pph restart`。不要将受信任来源设为 `0.0.0.0/0`。

## 添加和使用节点

首个节点是自身 VPS，名称为系统主机名，不可删除，可以禁用。通过 **添加节点** 或 **节点文件 → 导入节点** 添加其他上游。

| 接入协议 | 默认端口 | 用途 |
| --- | --- | --- |
| HTTP / SOCKS5 | 自身 `39999/TCP`，其他节点从 `40000/TCP` 起 | VPS 本机、Docker |
| HY2 | 与该节点 HTTP/SOCKS5 同号，使用 UDP | 外部客户端 |
| VLESS + RAW + Reality | 从 `50000/TCP` 起 | 外部客户端 |

自身节点直接出站，导入节点通过对应上游出站。列表中的协议按钮用于复制连接；启停和参数配置在 **更多 → 节点设置**。

### HTTP / SOCKS5

列表上方选择 **本机 / Docker / 公网**，再点击节点的 HTTP 或 SOCKS5。多选节点后，可用 **复制所选** 批量复制。

默认只允许本机和 Docker 访问。需要公网 HTTP/SOCKS5 时，在 `.env` 设置 `PROXY_EXTERNAL_CIDRS=你的来源IP/32`，执行 `pph restart`；公网使用优先选择加密的 HY2/VLESS。

### HY2

1. 在 **设置 → HY2 设置** 配置证书。
2. 在节点的 **更多 → 节点设置** 开启 HY2。
3. 点击节点的 **HY2** 复制公网连接。

自动申请证书：域名直连此 VPS，Cloudflare 使用灰云，公网 TCP `443` 可达且未被其他程序占用。项目运行期间自动续期。

`443` 被其他程序占用时，使用已有证书，填写 VPS 上证书和私钥的绝对路径。自签证书须由客户端信任，不要跳过证书校验。

### VLESS / Reality

1. 在节点的 **更多 → 节点设置** 点击 VLESS 设置按钮。
2. 填写此 VPS 的公网 IP 或直连域名，以及兼容 Reality 的目标 SNI（默认 `www.apple.com`），保存。
3. 点击节点的 **VLESS** 复制公网连接。

无需申请证书。VLESS 行的开关可单独启停，齿轮用于修改参数；停用不会更换端口和凭据。HY2/VLESS 不经过 HTTP 反代或 Cloudflare 橙云，云安全组须放行实际使用的端口。

### Docker 使用代理

复制场景选择 **Docker**，将复制的地址填入其他应用的代理配置。在该应用现有 Compose 服务中合并：

```yaml
services:
  app:
    extra_hosts:
      - "host:host-gateway"
```

`app` 换成现有服务名；无需新建网络。此配置用于同机 Bridge 容器，新建 Docker 网络后执行 `pph restart`。Host 网络容器使用“本机”地址。

## 日常维护

| 命令 | 操作 |
| --- | --- |
| `pph` | 查看状态 |
| `pph logs` | 查看实时日志，Ctrl+C 退出 |
| `pph restart` | 重启并应用 `.env` 配置 |
| `pph stop` / `pph start` | 停止 / 启动 |
| `pph update` | 更新并重启，保留密码和节点 |
| `pph enable` | 注册服务并开启开机启动 |
| `pph uninstall` | 卸载服务，保留项目文件和配置 |
| `pph uninstall --purge` | 二次确认后删除整个项目目录 |

旧版没有 `pph` 时，在项目目录执行一次 `sudo bash deploy/update.sh`。`pph stop` 不取消开机启动，`pph` 不管理其他服务。节点和协议变更会重载核心，已有连接可能断开。

彻底卸载前先导出节点并备份；项目目录外的证书和共享防火墙端口规则不删除。

## 备份与安全

连接日志页右上角齿轮可设置空间上限（默认 50 MB）和保留天数，或验证密码后清空连接记录；清空不影响累计流量。

- 备份 `/opt/proxypoolhub` 下的 `.env`、`data/proxies.json`、`runtime/acme`，这些文件包含敏感凭据，不要公开。
- **节点文件 → 导出节点** 可迁移普通上游节点；HY2/VLESS 入口需在新服务器重新配置。导出文件也含代理凭据。
- 在 **设置** 中修改密码、绑定验证器。管理新密码至少 12 位，代理新密码至少 16 位，均需大小写字母、数字和符号；启用验证器后，登录需要密码和动态验证码。
- 验证器名称为 `ProxyPH-服务器主机名:用户名`。已绑定的手机条目不会自动改名，可在验证器 App 中手动重命名。
- **节点设置 → 重置连接凭据** 会让旧 HY2/VLESS 凭据失效，客户端须重新复制连接。

## Windows

当前 `ProxySocks5Tray.exe` 是托盘启动器，不是独立版；需要 Node.js 18+、.NET 8 桌面运行时，以及项目的 `server.js`、`src/`、`web/`、`.env.example`。无需编译 C# 源码。

下载项目文件，将 [Releases](https://github.com/yinSam612/ProxyPoolHub/releases) 中的 EXE 放到项目根目录运行。双击托盘图标打开面板，托盘菜单可设置开机启动。

`proxy.bat web` 前台运行，`proxy.bat stop` 停止服务。
