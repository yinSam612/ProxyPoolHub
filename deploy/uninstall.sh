#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo '请使用 sudo 或 root 执行卸载。' >&2; exit 1; fi
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --purge ]; }; then
    echo '用法: pph uninstall [--purge]' >&2; exit 2
fi
app_dir="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
purge="${1:-}"
unit=/etc/systemd/system/proxypoolhub.service
shortcut=/usr/local/bin/pph
case "$app_dir" in
    /|/opt|/usr|/usr/local|/etc|/var|/tmp|/home|/root|/srv|/run|/mnt|/media)
        echo '拒绝卸载：项目目录不安全。' >&2; exit 1 ;;
esac
[ -f "$app_dir/server.js" ] || { echo '未找到项目 server.js。' >&2; exit 1; }
if [ -e "$shortcut" ] || [ -L "$shortcut" ]; then
    [ "$(readlink -f "$shortcut")" = "$app_dir/deploy/pph.sh" ] || { echo 'pph 属于另一个安装，未作修改。' >&2; exit 1; }
fi
if [ -e "$unit" ]; then
    grep -Fxq "WorkingDirectory=$app_dir" "$unit" || { echo '系统服务属于另一个安装，未作修改。' >&2; exit 1; }
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    fragment=$(systemctl show proxypoolhub -p FragmentPath --value)
    if [ -n "$fragment" ] && [ "$fragment" != "$unit" ]; then
        echo '系统服务不由本项目安装脚本管理，未作修改。' >&2; exit 1
    fi
fi
echo "卸载 ProxyPoolHub 服务: $app_dir"
echo '默认保留项目文件、节点、密码和证书。不会删除 Node.js 或其他服务。'
read -r -p '输入 UNINSTALL 确认: ' confirmation || exit 1
if [ "$confirmation" != UNINSTALL ]; then echo '已取消。'; exit 0; fi
if [ "$purge" = --purge ]; then
    echo "将永久删除整个目录（含节点、密码和项目内证书）: $app_dir"
    read -r -p '再次输入上述完整目录确认删除: ' confirmation || exit 1
    if [ "$confirmation" != "$app_dir" ]; then echo '已取消，未作修改。'; exit 0; fi
fi

pm2_owned=false
if command -v pm2 >/dev/null 2>&1; then
    pm2_owned=$(pm2 jlist | node -e '
        let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{
            const app=JSON.parse(input).find(p=>p.name==="proxypoolhub");
            if(app && app.pm2_env.pm_exec_path!==process.argv[1]+"/server.js") { console.error("PM2 服务属于另一个安装，未作修改。"); process.exit(1); }
            console.log(Boolean(app));
        });' "$app_dir")
fi

if [ -e "$unit" ]; then
    systemctl disable --now proxypoolhub
    rm -f -- "$unit"
    systemctl daemon-reload
    systemctl reset-failed proxypoolhub >/dev/null 2>&1 || true
fi
if [ "$pm2_owned" = true ]; then pm2 delete proxypoolhub; pm2 save --force; fi
if command -v nft >/dev/null 2>&1 && nft list table inet pph_security >/dev/null 2>&1; then
    nft delete table inet pph_security
fi
if command -v ufw >/dev/null 2>&1; then
    ufw status numbered | sed -nE '/# ProxyPoolHub ACME TLS-ALPN/b; /# ProxyPoolHub /s/^\[ *([0-9]+)\].*/\1/p' | sort -rn | while read -r number; do
        ufw --force delete "$number"
    done
fi
if [ -L "$shortcut" ]; then rm -f -- "$shortcut"; fi
if [ "$purge" = --purge ]; then
    cd /
    rm -rf -- "$app_dir"
    echo '已卸载并删除项目目录。'
else
    echo "已卸载服务，项目文件保留在 $app_dir。"
fi
