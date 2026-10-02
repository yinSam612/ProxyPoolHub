#!/usr/bin/env bash
# ==============================================================================
# ProxyPoolHub 一键平滑更新脚本
# 自动保留用户已有 .env 配置与 data/proxies.json 节点列表
# ==============================================================================

set -e
if [ "$(id -u)" -ne 0 ]; then
    echo '请使用 sudo 或 root 执行更新脚本。' >&2
    exit 1
fi

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}       ProxyPoolHub 平滑无损更新程序                ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 函数: 执行项目更新与服务平滑重载
update_app() {
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$app_dir"

    echo -e "${YELLOW}[1/3] 从远端拉取最新代码...${NC}"
    git pull --ff-only

    echo -e "${YELLOW}[2/3] 检查并更新项目依赖...${NC}"
    npm install --omit=dev
    if ! command -v nft >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then apt-get install -y nftables;
        elif command -v yum >/dev/null 2>&1; then yum install -y nftables;
        elif command -v apk >/dev/null 2>&1; then apk add --no-cache nftables;
        else echo 'Install nftables before updating.' >&2; exit 1; fi
    fi
    sed -i '/^MANAGE_FIREWALL=/d; /^REQUIRE_AUTH=/d' .env
    printf '\nMANAGE_FIREWALL=true\nREQUIRE_AUTH=true\n' >> .env
    chmod 600 .env

    echo -e "${YELLOW}[3/3] 重启后台服务...${NC}"
    bash "$app_dir/deploy/service.sh"

    local start_port
    start_port=$(grep '^PROXY_START_PORT=' "$app_dir/.env" 2>/dev/null | cut -d= -f2)
    start_port=${start_port:-40000}
    local end_port=$((start_port + 100))
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qw active; then
        ufw allow "${start_port}:${end_port}/tcp" comment 'ProxyPoolHub Proxy Ports'
        ufw allow "${start_port}:${end_port}/udp" comment 'ProxyPoolHub HY2 Relays'
        ufw allow 39999 comment 'ProxyPoolHub Local VPS'
        ufw allow 443/tcp comment 'ProxyPoolHub ACME TLS-ALPN'
        ufw allow 50000:50100/tcp comment 'ProxyPoolHub Reality'
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd --permanent --add-port="${start_port}-${end_port}/udp"
        firewall-cmd --permanent --add-port=39999/tcp
        firewall-cmd --permanent --add-port=39999/udp
        firewall-cmd --permanent --add-port=443/tcp
        firewall-cmd --permanent --add-port=50000-50100/tcp
        firewall-cmd --reload
    fi
}

update_app

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}           🎉 ProxyPoolHub 更新完成！               ${NC}"
echo -e "${GREEN}====================================================${NC}\n"
