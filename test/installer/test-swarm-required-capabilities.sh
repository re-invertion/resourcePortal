#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Installer control-plane can be sourced for pure helper coverage.
source "$root/scripts/installer/control-plane.sh"
calls=()
capabilities='null'
docker() {
  case "$1 $2" in
    'service inspect') printf '%s\n' "$capabilities";;
    'service update')
      calls+=("$*")
      capabilities='["NET_ADMIN","SYS_ADMIN","SYS_PTRACE"]'
      ;;
    *) printf 'unexpected docker call: %s\n' "$*" >&2; return 9 ;;
  esac
}
rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN SYS_PTRACE
[[ "${#calls[@]}" -eq 1 ]] || { echo 'expected one capability update' >&2; exit 1; }
[[ "${calls[0]}" == *'--cap-add NET_ADMIN'* && "${calls[0]}" == *'--cap-add SYS_ADMIN'* && "${calls[0]}" == *'--cap-add SYS_PTRACE'* ]] || exit 1
rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN
[[ "${#calls[@]}" -eq 1 ]] || { echo 'unexpected second update' >&2; exit 1; }
capabilities='["NET_ADMIN"]'
docker() {
  case "$1 $2" in
    'service inspect') printf '%s\n' "$capabilities";;
    'service update') return 7 ;;
    *) return 9 ;;
  esac
}
if rp_ensure_swarm_service_capabilities test_router NET_ADMIN SYS_ADMIN 2>/dev/null; then
  echo 'missing capabilities fail-open' >&2; exit 1
fi
echo 'PASS Swarm capabilities are idempotent and fail closed'
