#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
action="${1:-status}"
case "$action" in
    status|logs) ;;
    start|stop|restart|enable|update|uninstall)
        if [ "$(id -u)" -ne 0 ]; then exec sudo bash "$app_dir/deploy/pph.sh" "$@"; fi ;;
    help|-h|--help)
        echo 'pph [status|logs|start|stop|restart|enable|update|uninstall [--purge]]'
        exit 0 ;;
    *) echo "Unknown command: $action. Try pph help." >&2; exit 2 ;;
esac

if [ "$action" = update ]; then exec bash "$app_dir/deploy/update.sh"; fi
if [ "$action" = enable ]; then exec bash "$app_dir/deploy/service.sh"; fi
if [ "$action" = uninstall ]; then shift; exec bash "$app_dir/deploy/uninstall.sh" "$@"; fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    case "$action" in
        status)
            status=0
            systemctl --no-pager status proxypoolhub || status=$?
            systemctl is-enabled proxypoolhub || true
            exit "$status" ;;
        logs) exec journalctl -u proxypoolhub -n 100 -f ;;
        *) exec systemctl "$action" proxypoolhub ;;
    esac
else
    case "$action" in
        status) exec pm2 describe proxypoolhub ;;
        logs) exec pm2 logs proxypoolhub --lines 100 ;;
        start|restart) pm2 restart proxypoolhub; pm2 save ;;
        stop) exec pm2 stop proxypoolhub ;;
    esac
fi
