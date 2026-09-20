#!/usr/bin/env bash
# ==============================================================================
# Proxy-SOCKS5-CF 一键更新脚本 (平滑无损更新)
# 自动保留用户已有 .env 配置与 data/proxies.json 节点列表
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}  Proxy-SOCKS5-CF 平滑无损更新程序                  ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 函数: 执行项目更新与依赖刷新
update_app() {
    local app_dir
    app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$app_dir"

    echo -e "${YELLOW}[1/3] 从远端拉取最新代码...${NC}"
    git fetch --all
    # 保证工作区节点数据与配置文件不受影响
    git pull

    echo -e "${YELLOW}[2/3] 检查并更新项目依赖...${NC}"
    npm install --omit=dev

    echo -e "${YELLOW}[3/3] 重启后台服务...${NC}"
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet proxy-socks5 2>/dev/null; then
        systemctl restart proxy-socks5
        echo -e "${GREEN}✓ Systemd 服务已重启并应用最新版本${NC}"
    elif command -v pm2 >/dev/null 2>&1 && pm2 describe proxy-socks5 >/dev/null 2>&1; then
        pm2 restart proxy-socks5
        echo -e "${GREEN}✓ PM2 服务已重启并应用最新版本${NC}"
    else
        echo -e "${YELLOW}未检测到正在运行的系统服务，请根据实际运行方式手动重启服务。${NC}"
    fi
}

update_app

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}         🎉 Proxy-SOCKS5 更新完成！               ${NC}"
echo -e "${GREEN}====================================================${NC}\n"
