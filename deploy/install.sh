#!/usr/bin/env bash
# ==============================================================================
# ProxyPoolHub 一键部署脚本 (Linux / VPS 原生系统服务版)
# 支持系统: Ubuntu / Debian / CentOS / Rocky / AlmaLinux / Alpine
# 自动生成随机安全强密码，开机自启守护
# ==============================================================================

set -e

# 终端输出高亮颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}       ProxyPoolHub 系统服务一键部署程序            ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 函数: 检查管理员权限
check_privileges() {
    if [ "$(id -u)" -ne 0 ]; then
        echo -e "${RED}[错误] 请使用 sudo 或 root 权限执行此部署脚本！${NC}"
        exit 1
    fi
}

# 函数: 生成随机安全密码
generate_random_password() {
    if command -v openssl >/dev/null 2>&1; then
        printf '%saA1!\n' "$(openssl rand -hex 16)"
    else
        printf '%saA1!\n' "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    fi
}

# 函数: 检测并安装基础工具
install_base_tools() {
    echo -e "${YELLOW}[1/6] 检查系统基础工具...${NC}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y curl tar git openssl >/dev/null 2>&1
    elif command -v yum >/dev/null 2>&1; then
        yum install -y curl tar git openssl >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache curl tar git openssl bash
    fi
}

# 函数: 检测并安装 Node.js LTS 运行环境 (要求 >= 18.0.0)
check_nodejs() {
    echo -e "${YELLOW}[2/6] 检查 Node.js 运行环境...${NC}"
    local need_install=0
    if ! command -v node >/dev/null 2>&1; then
        need_install=1
    else
        local node_ver
        node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$node_ver" -lt 18 ]; then
            need_install=1
        fi
    fi

    if [ "$need_install" -eq 1 ]; then
        echo -e "${BLUE}正在安装 Node.js 20 LTS...${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
        elif command -v yum >/dev/null 2>&1; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
            yum install -y nodejs
        elif command -v apk >/dev/null 2>&1; then
            apk add --no-cache nodejs npm
        fi
    fi
    echo -e "${GREEN}✓ Node.js 环境就绪: $(node -v)${NC}"
}

# 函数: 初始化依赖与生成随机凭据
install_dependencies() {
    echo -e "${YELLOW}[3/6] 初始化项目配置与依赖...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$app_dir"

    npm install --omit=dev

    mkdir -p data runtime

    # 配置 .env，初次创建时自动生成随机强密码
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
        else
            touch .env
        fi

        local rand_admin_pass
        rand_admin_pass=$(generate_random_password)
        local rand_proxy_pass
        rand_proxy_pass=$(generate_random_password)

        sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${rand_admin_pass}/" .env 2>/dev/null || echo "ADMIN_PASSWORD=${rand_admin_pass}" >> .env
        sed -i "s/^PROXY_PASSWORD=.*/PROXY_PASSWORD=${rand_proxy_pass}/" .env 2>/dev/null || echo "PROXY_PASSWORD=${rand_proxy_pass}" >> .env
        sed -i "s/^WEB_PORT=.*/WEB_PORT=3100/" .env 2>/dev/null || echo "WEB_PORT=3100" >> .env
        sed -i "s/^WEB_HOST=.*/WEB_HOST=0.0.0.0/" .env 2>/dev/null || echo "WEB_HOST=0.0.0.0" >> .env
        sed -i "s/^PROXY_LISTEN_ADDRESS=.*/PROXY_LISTEN_ADDRESS=0.0.0.0/" .env 2>/dev/null || echo "PROXY_LISTEN_ADDRESS=0.0.0.0" >> .env
        chmod 600 .env
        echo -e "${GREEN}✓ 已自动生成随机安全管理员密码并保存到 .env${NC}"
    else
        sed -i "s/^WEB_HOST=127.0.0.1/WEB_HOST=0.0.0.0/" .env 2>/dev/null || true
        sed -i "s/^PROXY_LISTEN_ADDRESS=127.0.0.1/PROXY_LISTEN_ADDRESS=0.0.0.0/" .env 2>/dev/null || true
    fi

    # 初始化示例节点数据
    if [ ! -f "data/proxies.json" ]; then
        if [ -f "data/proxies.json.example" ]; then
            cp data/proxies.json.example data/proxies.json
        else
            echo '{"version":1,"settings":{},"proxies":[]}' > data/proxies.json
        fi
    fi
}

# 函数: 检查平台对应 sing-box 二进制内核
ensure_singbox_binary() {
    echo -e "${YELLOW}[4/6] 检查 sing-box 内核...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$app_dir"
    node -e 'require("./src/core/proxy-manager").ensureSingBoxBinary().then(file => console.log("sing-box ready: " + file)).catch(error => { console.error(error.message); process.exit(1); })'
}

# 函数: 注册并启动 Systemd / PM2 系统常驻服务
setup_system_service() {
    echo -e "${YELLOW}[5/6] 配置系统服务守护...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    bash "$app_dir/deploy/service.sh"
}

# 函数: 检查并配置系统防火墙放行端口
configure_firewall() {
    echo -e "${YELLOW}[6/6] 检查系统防火墙端口放行...${NC}"
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local web_port
    web_port=$(grep '^WEB_PORT=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "3100")
    local start_port
    start_port=$(grep '^PROXY_START_PORT=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "40000")
    local end_port=$((start_port + 100))

    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qw "active"; then
        ufw allow "${web_port}/tcp" comment 'ProxyPoolHub Web Admin' >/dev/null 2>&1 || true
        ufw allow "${start_port}:${end_port}/tcp" comment 'ProxyPoolHub Proxy Ports' >/dev/null 2>&1 || true
        ufw allow "${start_port}:${end_port}/udp" comment 'ProxyPoolHub HY2 Relays' >/dev/null 2>&1 || true
        ufw allow 39999 comment 'ProxyPoolHub Local VPS' >/dev/null 2>&1 || true
        ufw allow 443/tcp comment 'ProxyPoolHub ACME TLS-ALPN' >/dev/null 2>&1 || true
        ufw allow 50000:50100/tcp comment 'ProxyPoolHub Reality' >/dev/null 2>&1 || true
        echo -e "${GREEN}✓ UFW 防火墙已放行: ${web_port}/tcp、${start_port}:${end_port}/tcp+udp、443/tcp${NC}"
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="${web_port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port="${start_port}-${end_port}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port="${start_port}-${end_port}/udp" >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port=39999/tcp >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port=39999/udp >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-port=50000-50100/tcp >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        echo -e "${GREEN}✓ Firewalld 防火墙已放行: ${web_port}/tcp、${start_port}-${end_port}/tcp+udp、443/tcp${NC}"
    fi
}

# 执行各阶段
check_privileges
install_base_tools
check_nodejs
install_dependencies
ensure_singbox_binary
setup_system_service
configure_firewall

# 获取当前公网 IP 与配置凭据用于终端展示
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server_ip=$(curl -s4 https://api.ipify.org || curl -s4 https://ifconfig.me || echo "服务器IP")
admin_user=$(grep '^ADMIN_USER=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "admin")
admin_pass=$(grep '^ADMIN_PASSWORD=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "")
if [ -f "$app_dir/data/proxies.json" ] && grep -q '"adminPasswordHash"' "$app_dir/data/proxies.json"; then
    admin_pass='已在 Web 面板修改，请使用新密码'
fi
proxy_user=$(grep '^PROXY_USERNAME=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "proxy")
proxy_pass=$(grep '^PROXY_PASSWORD=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "")
web_port=$(grep '^WEB_PORT=' "$app_dir/.env" 2>/dev/null | cut -d= -f2 || echo "3100")

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}           🎉 ProxyPoolHub 部署完成！               ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Web 管理面板:   ${BLUE}http://${server_ip}:${web_port}${NC}"
echo -e "管理员账号:     ${YELLOW}${admin_user}${NC}"
echo -e "管理员密码:     ${GREEN}${admin_pass}${NC}"
echo -e "代理认证账号:   ${YELLOW}${proxy_user}${NC}"
echo -e "代理认证密码:   ${GREEN}${proxy_pass}${NC}"
echo -e "代理起始端口:   ${BLUE}40000+${NC}"
echo -e "HY2 中转端口:   ${BLUE}与节点 HTTP/SOCKS5 同号，使用 UDP${NC}"
echo -e "===================================================="
echo -e "服务状态查看:   ${YELLOW}pph${NC}"
echo -e "服务实时日志:   ${YELLOW}pph logs${NC}"
echo -e "重启 / 更新:    ${YELLOW}pph restart / pph update${NC}"
echo -e "Reality 端口:   ${BLUE}50000-50100/TCP，按节点开启${NC}"
echo -e "配置文件路径:   ${BLUE}${app_dir}/.env${NC}"
echo -e "${GREEN}====================================================${NC}\n"
