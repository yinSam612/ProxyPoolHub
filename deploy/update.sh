#!/usr/bin/env bash
# ==============================================================================
# ProxyPoolHub 一键平滑更新脚本
# 自动保留用户已有 .env 配置与 data/proxies.json 节点列表
# ==============================================================================

set -e

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
    git fetch --all
    git pull

    echo -e "${YELLOW}[2/3] 检查并更新项目依赖...${NC}"
    npm install --omit=dev

    echo -e "${YELLOW}[3/3] 重启后台服务...${NC}"
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet proxypoolhub 2>/dev/null; then
        systemctl restart proxypoolhub
        echo -e "${GREEN}✓ Systemd 服务已重启并应用最新版本 (proxypoolhub)${NC}"
    elif command -v pm2 >/dev/null 2>&1 && pm2 describe proxypoolhub >/dev/null 2>&1; then
        pm2 restart proxypoolhub
        echo -e "${GREEN}✓ PM2 服务已重启并应用最新版本 (proxypoolhub)${NC}"
    else
        echo -e "${YELLOW}未检测到正在运行的 proxypoolhub 服务，请根据实际情况手动启动服务。${NC}"
    fi
}

update_app

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}           🎉 ProxyPoolHub 更新完成！               ${NC}"
echo -e "${GREEN}====================================================${NC}\n"
