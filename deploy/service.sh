#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo 'Run with sudo or root.' >&2
    exit 1
fi
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_path="$(command -v node)"
if [ -e /usr/local/bin/pph ] && [ "$(readlink -f /usr/local/bin/pph)" != "$app_dir/deploy/pph.sh" ]; then
    echo '/usr/local/bin/pph already belongs to another installation; not overwritten.' >&2
    exit 1
fi
chmod +x "$app_dir/deploy/pph.sh"
ln -sfn "$app_dir/deploy/pph.sh" /usr/local/bin/pph

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/proxypoolhub.service <<EOF
[Unit]
Description=ProxyPoolHub Multi-Protocol Proxy Pool Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${app_dir}
EnvironmentFile=-${app_dir}/.env
ExecStart="${node_path}" "${app_dir}/server.js"
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable proxypoolhub
    systemctl restart proxypoolhub
    systemctl is-active --quiet proxypoolhub
    systemctl is-enabled --quiet proxypoolhub
else
    command -v pm2 >/dev/null 2>&1 || npm install -g pm2
    cd "$app_dir"
    pm2 delete proxypoolhub >/dev/null 2>&1 || true
    pm2 start server.js --name proxypoolhub
    pm2 startup
    pm2 save
fi
echo 'Installed: pph; automatic startup enabled.'
