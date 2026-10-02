#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for script in "$root"/deploy/*.sh; do bash -n "$script"; done
grep -q '^EnvironmentFile=-${app_dir}/.env$' "$root/deploy/service.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export PPH_TEST_LOG="$tmp/commands"
cat > "$tmp/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$PPH_TEST_LOG"
EOF
cat > "$tmp/journalctl" <<'EOF'
#!/bin/sh
echo "journalctl $*" >> "$PPH_TEST_LOG"
EOF
cat > "$tmp/bash" <<'EOF'
#!/bin/sh
echo "bash $*" >> "$PPH_TEST_LOG"
EOF
chmod +x "$tmp/systemctl" "$tmp/journalctl" "$tmp/bash"
export PATH="$tmp:$PATH"
for action in status logs start stop restart enable update; do /bin/bash "$root/deploy/pph.sh" "$action"; done
grep -q 'systemctl --no-pager status proxypoolhub' "$PPH_TEST_LOG"
grep -q 'systemctl is-enabled proxypoolhub' "$PPH_TEST_LOG"
grep -q 'journalctl -u proxypoolhub -n 100 -f' "$PPH_TEST_LOG"
for action in start stop restart; do grep -q "systemctl $action proxypoolhub" "$PPH_TEST_LOG"; done
grep -q "bash $root/deploy/service.sh" "$PPH_TEST_LOG"
grep -q "bash $root/deploy/update.sh" "$PPH_TEST_LOG"
/bin/bash "$root/deploy/pph.sh" help
if /bin/bash "$root/deploy/pph.sh" invalid 2>/dev/null; then exit 1; fi
echo 'Deploy passed: shell syntax and all pph commands (mocked, no real service changes).'
