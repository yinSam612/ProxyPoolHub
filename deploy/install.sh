#!/usr/bin/env bash
# ==============================================================================
# Proxy-SOCKS5-CF 一键部署脚本 (Linux / VPS 原生系统服务版)
# 支持环境: Ubuntu / Debian / CentOS / Rocky / AlmaLinux / Alpine
# ==============================================================================

set -e

# 字体颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}  Proxy-SOCKS5-CF 一键系统服务部署程序 (Native VPS)  ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 函数: 检查当前是否具备管理员权限
check_privileges() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}[错误] 请使用 sudo 或 root 用户权限运行此脚本！${NC}"
        exit 1
    fi
}

# 函数: 检测并安装基础工具 (curl, tar, git)
install_base_tools() {
    echo -e "${YELLOW}[1/5] 检查系统基础工具...${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y curl tar git >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
        yum install -y curl tar git >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl tar git bash
    fi
}

# 函数: 检测并配置 Node.js 运行环境 (要求 >= 18.0.0)
check_nodejs() {
    echo -e "${YELLOW}[2/5] 检查 Node.js 运行环境...${NC}"
    local need_install=0
    if ! command -v node >/dev/null 2>&1; then
        need_install=1
    else
        local node_ver
        node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$node_ver" -lt 18 ]; then
            echo -e "${YELLOW}当前 Node.js 版本 (v$(node -v)) 过低，需要 v18+${NC}"
            need_install=1
        fi
    fi

    if [ "$need_install" -eq 1 ]; then
        echo -e "${BLUE}正在安装 Node.js 20 LTS 环境...${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
        elif command -v yum >/dev/null 2>&1; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            yum install -y nodejs
        elif command -v apk >/dev/null 2>&1; then
            apk add --no-cache nodejs npm
        else
            echo -e "${RED}[错误] 无法自动安装 Node.js，请手动安装 Node.js 18+ 后重试！${NC}"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓ Node.js 环境就绪: $(node -v)${NC}"
}

# 函数: 初始化项目依赖与运行环境
install_dependencies() {
    echo -e "${YELLOW}[3/5] 安装项目依赖与初始化配置...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$app_dir"

    # 安装 npm 生产依赖
    npm install --omit=dev

    # 保护并初始化 .env 配置文件
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            echo -e "${GREEN}已创建默认 .env 配置文件${NC}"
        fi
    fi

    # 保护并初始化 data/proxies.json 节点数据文件
    mkdir -p data runtime
    if [ ! -f "data/proxies.json" ]; then
        if [ -f "data/proxies.json.example" ]; then
            cp data/proxies.json.example data/proxies.json
            echo -e "${GREEN}已初始化节点数据文件 data/proxies.json${NC}"
        else
            echo '{"version":1,"settings":{},"proxies":[]}' > data/proxies.json
        fi
    fi
}

# 函数: 检测并下载平台对应的 sing-box 二进制内核
ensure_singbox_binary() {
    echo -e "${YELLOW}[4/5] 检查 sing-box 内核...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local target_bin="$app_dir/runtime/sing-box"

    if [ -f "$target_bin" ] && [ -x "$target_bin" ]; then
        echo -e "${GREEN}✓ sing-box 内核已存在: $($target_bin version 2>&1 | head -n 1)${NC}"
        return 0
    fi

    local arch
    arch="$(uname -m)"
    local sb_arch=""
    case "$arch" in
        x86_64|amd64) sb_arch="linux-amd64" ;;
        aarch64|arm64) sb_arch="linux-arm64" ;;
        armv7l) sb_arch="linux-armv7" ;;
        *) echo -e "${RED}不支持的架构: $arch，需手动放置 sing-box 二进制到 runtime/ 目录${NC}"; return 0 ;;
    esac

    echo -e "${BLUE}正在下载 sing-box ($sb_arch)...${NC}"
    local sb_ver="1.11.4"
    local download_url="https://github.com/SagerNet/sing-box/releases/download/v${sb_ver}/sing-box-${sb_ver}-${sb_arch}.tar.gz"
    local temp_tar="/tmp/sing-box.tar.gz"

    if curl -fsSL -o "$temp_tar" "$download_url"; then
        tar -xzf "$temp_tar" -C /tmp
        mv /tmp/sing-box-${sb_ver}-${sb_arch}/sing-box "$target_bin"
        chmod +x "$target_bin"
        rm -rf "$temp_tar" /tmp/sing-box-${sb_ver}-${sb_arch}
        echo -e "${GREEN}✓ sing-box 内核安装成功${NC}"
    else
        echo -e "${YELLOW}[警告] 自动下载 sing-box 超时，系统将在初次启动时由 Node 自动按需获取${NC}"
    fi
}

# 函数: 注册并启动 Systemd / PM2 系统服务
setup_system_service() {
    echo -e "${YELLOW}[5/5] 配置系统常驻服务...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local node_path
    node_path="$(command -v node)"

    if command -v systemctl >/dev/null 2>&1; then
        local service_file="/etc/systemd/system/proxy-socks5.service"
        cat <<EOF > "$service_file"
[Unit]
Description=Proxy SOCKS5 & HTTP Relay Manager
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${app_dir}
EnvironmentFile=-${app_dir}/.env
ExecStart=${node_path} ${app_dir}/server.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

        systemctl daemon-reload
        systemctl enable proxy-socks5
        systemctl restart proxy-socks5
        echo -e "${GREEN}✓ Systemd 服务配置并启动成功 (proxy-socks5)${NC}"
    else
        # 无 systemd 环境则使用 PM2 守护
        if ! command -v pm2 >/dev/null 2>&1; then
            npm install -g pm2
        fi
        cd "$app_dir"
        pm2 delete proxy-socks5 >/dev/null 2>&1 || true
        pm2 start server.js --name proxy-socks5
        pm2 save
        echo -e "${GREEN}✓ PM2 常驻服务配置并启动成功${NC}"
    fi
}

# 依次执行各部署阶段
check_privileges
install_base_tools
check_nodejs
install_dependencies
ensure_singbox_binary
setup_system_service

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}         🎉 Proxy-SOCKS5 部署完成！               ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Web 管理面板: ${BLUE}http://服务器IP:3100${NC}"
echo -e "默认管理员:   ${YELLOW}admin${NC}"
echo -e "默认密码:     ${YELLOW}admin888${NC} (请登录后在 .env 或管理界面修改)"
echo -e "代理起始端口: ${BLUE}40000+${NC}"
echo -e "服务状态查看: ${YELLOW}systemctl status proxy-socks5${NC}"
echo -e "服务实时日志: ${YELLOW}journalctl -u proxy-socks5 -f${NC}"
echo -e "${GREEN}====================================================${NC}\n"
