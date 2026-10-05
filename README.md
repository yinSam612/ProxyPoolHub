# ProxyPoolHub

集中管理 VPS 代理节点，sing-box内核，提供 HTTP/SOCKS5、HY2 和 VLESS + RAW + Reality 接入。

## VPS 安装

在已安装 Git 的 VPS 上，以 root 执行：

```bash
git clone https://github.com/yinSam612/ProxyPoolHub.git /opt/proxypoolhub
cd /opt/proxypoolhub
bash deploy/install.sh
```

按提示设置管理员用户名，终端显示生成的密码。安装后立即启动，开机自启。

Web 默认仅监听本机 `3100`。在电脑上建立 SSH 隧道，将 `VPS_IP` 换成服务器地址：

```bash
ssh -L 3100:127.0.0.1:3100 root@VPS_IP
```

打开 `http://127.0.0.1:3100` 登录。SSH 端口不是 `22` 时，在命令中加 `-p 端口`。

域名访问：用 HTTPS 反向代理转发到 Web 端口，`.env` 的 `TRUSTED_PROXY_CIDRS` 仅填写反代来源。跨容器访问需调整 `WEB_HOST`；修改后执行 `pph restart`。

## 节点使用

首个节点以 VPS 主机名命名，直接出站，不可删除、可以禁用。其他节点支持 VLESS、HY2、Trojan，通过对应上游出站。

用 **添加节点** 手动添加，或用 **节点文件** 导入、导出上游。迁移后需重新配置新服务器的 HY2/VLESS 入口。

| 接入协议 | 默认端口 | 用途 |
| --- | --- | --- |
| HTTP / SOCKS5 | 自身 `39999/TCP`，其他从 `40000/TCP` 起 | 本机、Docker；可开启公网 |
| HY2 | 与该节点 HTTP/SOCKS5 同号，使用 UDP | 外部客户端 |
| VLESS + RAW + Reality | 从 `50000/TCP` 起 | 外部客户端 |

点击协议按钮复制连接，或多选后 **复制所选**。HTTP/SOCKS5 先选择 **本机 / Docker / 公网**；HY2/VLESS 为外部连接。

- **公网 HTTP/SOCKS5**：默认关闭。在列表的公网设置齿轮中填写 IP/CIDR 白名单再开启，须验证密码及已绑定的动态验证码。安装脚本已托管防火墙；手动部署需设置 `MANAGE_FIREWALL=true`。
- **HY2**：在 **设置 → HY2 设置** 配置证书，再到 **更多 → 节点设置** 开启。自动申请及续期需域名直连、TCP `443` 空闲且公网可达，Cloudflare 使用灰云。也可填写已有证书/私钥的绝对路径；自签证书需客户端信任。
- **VLESS / Reality**：在 **更多 → 节点设置** 配置公网 IP/直连域名、目标 SNI，无需申请证书。HY2、VLESS 可独立启停。

公开地址留空则使用服务器公网 IP。公网建议使用加密的 HY2/VLESS，并放行对应端口及云安全组；不能通过 HTTP 反代或 Cloudflare 橙云接入。

## Docker 使用代理

同一 VPS 上的应用：选择 **Docker** 复制地址，填入应用代理配置，在其 Compose 服务中加入：

```yaml
services:
  app:
    extra_hosts:
      - "host:host-gateway"
```

`app` 换成实际服务名，无需新建网络。Host 网络容器使用 **本机** 地址；新增 Docker 网络后执行 `pph restart`。

## 日常维护

| 命令 | 操作 |
| --- | --- |
| `pph` | 查看状态 |
| `pph logs` | 实时日志，Ctrl+C 退出 |
| `pph restart` | 重启并应用 `.env` 配置 |
| `pph stop` / `pph start` | 停止 / 启动 |
| `pph update` | 更新并重启，保留密码和节点 |
| `pph enable` | 注册服务并启用开机自启 |
| `pph uninstall` | 卸载服务，保留项目和数据 |
| `pph uninstall --purge` | 二次确认后删除整个项目，请先备份 |


更新、重启或节点配置变更可能断开连接。`pph stop` 不取消开机自启；这些命令不管理其他代理服务。

## 安全与数据

- **设置** 可修改密码、绑定验证器。新管理密码至少 12 位，代理密码至少 16 位，均需大小写字母、数字和符号。
- 验证器名称为 `ProxyPH-服务器主机名:用户名`。重置 HY2/VLESS 凭据后，旧连接失效，客户端需重新复制。
- **连接日志 → 齿轮** 可设置空间上限（默认 50 MB）、保留天数及手动清空；清空记录不影响累计流量。

## Windows 客户端

Windows x64 独立构建 `ProxySocks5Tray.exe` 内置运行环境，无需源码。将 HY2、VLESS、Trojan 转成本地 HTTP/SOCKS5；面板免登录、本地代理免密，远端节点凭据仍必需。

双击 EXE 启动，双击托盘图标打开面板；菜单可设置登录后自启。仅监听 `127.0.0.1`。数据在 `%LOCALAPPDATA%\ProxyPoolHub`，替换 EXE 升级保留数据。

构建独立版：安装 Node.js 和 .NET 8 SDK，运行 `tray-windows\build-tray.bat`，输出项目根目录的 `ProxySocks5Tray.exe`。
