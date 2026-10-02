#!/usr/bin/env bash
set -euo pipefail
# Run only in a disposable container: service and shortcut paths are real here.
[ -f /.dockerenv ] && [ "$(id -u)" -eq 0 ] || { echo 'Run this test in a disposable root Docker container.' >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
app="$tmp/app"
mkdir -p "$app/deploy" "$tmp/bin" /run/systemd/system /etc/systemd/system /usr/local/bin
cp "$root"/deploy/*.sh "$app/deploy/"
cp "$root/.env.example" "$app/.env.example"
touch "$app/server.js"
export PPH_TEST_LOG="$tmp/commands"
export PPH_MOCK_PM2='[]'
touch "$PPH_TEST_LOG"
real_node="$(command -v node)"
cat > "$tmp/bin/node" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = -e ] && [[ "\${2:-}" == *ensureSingBoxBinary* ]]; then exit 0; fi
exec "$real_node" "\$@"
EOF
for command in apt-get npm; do
    cat > "$tmp/bin/$command" <<'EOF'
#!/bin/sh
echo "$(basename "$0") $*" >> "$PPH_TEST_LOG"
EOF
done
cat > "$tmp/bin/curl" <<'EOF'
#!/bin/sh
echo 203.0.113.1
EOF
cat > "$tmp/bin/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$PPH_TEST_LOG"
if [ "$1" = show ] && [ -e /etc/systemd/system/proxypoolhub.service ]; then echo /etc/systemd/system/proxypoolhub.service; fi
EOF
cat > "$tmp/bin/pm2" <<'EOF'
#!/bin/sh
echo "pm2 $*" >> "$PPH_TEST_LOG"
if [ "$1" = jlist ]; then printf '%s\n' "$PPH_MOCK_PM2"; fi
EOF
cat > "$tmp/bin/nft" <<'EOF'
#!/bin/sh
echo "nft $*" >> "$PPH_TEST_LOG"
EOF
cat > "$tmp/bin/ufw" <<'EOF'
#!/bin/sh
echo "ufw $*" >> "$PPH_TEST_LOG"
if [ "$1 $2" = 'status numbered' ]; then
    printf '%s\n' '[ 1] 22/tcp ALLOW # SSH' '[ 3] 3100/tcp ALLOW # ProxyPoolHub Web Admin' '[ 8] 443/tcp ALLOW # Shared HTTPS' '[ 9] 443/tcp ALLOW # ProxyPoolHub ACME TLS-ALPN' '[12] 39999/tcp ALLOW # ProxyPoolHub Local VPS'
else echo 'Status: inactive'; fi
EOF
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"
unset ADMIN_USER

if bash "$app/deploy/install.sh" </dev/null >"$tmp/output" 2>&1; then echo 'Missing username was accepted'; exit 1; fi
[ ! -e "$app/.env" ]
[ ! -s "$PPH_TEST_LOG" ]
printf '\nbad name\nops-vps-01\n' | bash "$app/deploy/install.sh" >"$tmp/output" 2>"$tmp/errors"
[ ! -s "$tmp/errors" ]
! grep -q $'\r' "$app/.env"
grep -Fxq 'ADMIN_USER=ops-vps-01' "$app/.env"
! grep -Fxq 'ADMIN_USER=admin' "$app/.env"
grep -Eq '^ADMIN_PASSWORD=[a-f0-9]{32}aA1!$' "$app/.env"
[ "$(stat -c %a "$app/.env")" = 600 ]
original_password="$(grep '^ADMIN_PASSWORD=' "$app/.env")"
ADMIN_USER=should-not-replace bash "$app/deploy/install.sh" </dev/null >"$tmp/output"
grep -Fxq 'ADMIN_USER=ops-vps-01' "$app/.env"
grep -Fxq "$original_password" "$app/.env"
mkdir -p "$app/runtime/acme"
echo retained > "$app/runtime/acme/cert.pem"
cp "$app/data/proxies.json" "$tmp/nodes.json"

: > "$PPH_TEST_LOG"
printf 'cancel\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output"
! grep -q 'disable --now\|nft delete\|ufw --force delete' "$PPH_TEST_LOG"
[ -e /etc/systemd/system/proxypoolhub.service ]
ln -sfn "$tmp/another-install" /usr/local/bin/pph
if printf 'UNINSTALL\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output" 2>&1; then echo 'Foreign shortcut was accepted'; exit 1; fi
ln -sfn "$app/deploy/pph.sh" /usr/local/bin/pph
cp /etc/systemd/system/proxypoolhub.service "$tmp/unit"
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=$tmp/another-install|" /etc/systemd/system/proxypoolhub.service
if printf 'UNINSTALL\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output" 2>&1; then echo 'Foreign service was accepted'; exit 1; fi
cp "$tmp/unit" /etc/systemd/system/proxypoolhub.service
export PPH_MOCK_PM2='[{"name":"proxypoolhub","pm2_env":{"pm_exec_path":"/another-install/server.js"}}]'
if printf 'UNINSTALL\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output" 2>&1; then echo 'Foreign PM2 service was accepted'; exit 1; fi
export PPH_MOCK_PM2="[{\"name\":\"proxypoolhub\",\"pm2_env\":{\"pm_exec_path\":\"$app/server.js\"}},{\"name\":\"other-app\"}]"
: > "$PPH_TEST_LOG"
printf 'UNINSTALL\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output"
[ ! -e /etc/systemd/system/proxypoolhub.service ]
[ ! -L /usr/local/bin/pph ]
grep -Fxq "$original_password" "$app/.env"
cmp "$app/data/proxies.json" "$tmp/nodes.json"
grep -Fxq retained "$app/runtime/acme/cert.pem"
grep -Fxq 'systemctl disable --now proxypoolhub' "$PPH_TEST_LOG"
grep -Fxq 'pm2 delete proxypoolhub' "$PPH_TEST_LOG"
grep -Fxq 'pm2 save --force' "$PPH_TEST_LOG"
grep -Fxq 'nft delete table inet pph_security' "$PPH_TEST_LOG"
grep -Fxq 'ufw --force delete 12' "$PPH_TEST_LOG"
grep -Fxq 'ufw --force delete 3' "$PPH_TEST_LOG"
! grep -Eq 'ufw --force delete (1|8|9)$|pm2 delete other-app|flush' "$PPH_TEST_LOG"
stop_line="$(grep -n 'systemctl disable --now' "$PPH_TEST_LOG" | cut -d: -f1)"
firewall_line="$(grep -n 'nft delete' "$PPH_TEST_LOG" | cut -d: -f1)"
[ "$stop_line" -lt "$firewall_line" ]

export PPH_MOCK_PM2='[]'
bash "$app/deploy/install.sh" </dev/null >"$tmp/output"
: > "$PPH_TEST_LOG"
printf 'UNINSTALL\n/wrong-directory\n' | bash "$app/deploy/uninstall.sh" --purge >"$tmp/output"
! grep -q 'disable --now\|nft delete' "$PPH_TEST_LOG"
[ -e "$app/.env" ]
mkdir -p "$tmp/other-project"
echo safe > "$tmp/other-project/keep"
ln -s "$tmp/other-project" "$app/external-files"
printf 'UNINSTALL\n%s\n' "$app" | bash "$app/deploy/uninstall.sh" --purge >"$tmp/output"
[ ! -e "$app" ]
grep -Fxq safe "$tmp/other-project/keep"

mkdir -p "$app/deploy"
cp "$root"/deploy/*.sh "$app/deploy/"
cp "$root/.env.example" "$app/.env.example"
touch "$app/server.js"
ADMIN_USER=batch-ops bash "$app/deploy/install.sh" </dev/null >"$tmp/output"
grep -Fxq 'ADMIN_USER=batch-ops' "$app/.env"
printf 'UNINSTALL\n' | bash "$app/deploy/uninstall.sh" >"$tmp/output"
echo 'PASS: First-install username, validation/EOF, noninteractive account, existing credentials, owned service/PM2/firewall cleanup, cancellation, retained data and bounded purge.'
