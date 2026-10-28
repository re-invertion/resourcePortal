#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/test-nvidia-gpu-swarm.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/docker" <<'SH'
#!/usr/bin/env bash
case "$*" in
  "info --format {{.Swarm.NodeID}}") echo ku2gbq2sm1b2khra543dtyxfg ;;
  "info --format {{.DefaultRuntime}}") echo nvidia ;;
  "info --format {{.Swarm.ControlAvailable}}") echo true ;;
  "node ls --format {{.ID}}") echo ku2gbq2sm1b2khra543dtyxfg ;;
  "service ls --format {{.Name}}") echo resourceportal-control-plane_api ;;
  *) echo "UNSAFE MUTATION: docker $*" >&2; exit 99 ;;
esac
SH
cat >"$tmp/nvidia-smi" <<'SH'
#!/usr/bin/env bash
echo GPU-12345678-abcd-1234-abcd-123456789abc
SH
chmod +x "$tmp/docker" "$tmp/nvidia-smi"
output="$(PATH="$tmp:$PATH" RP_GPU_SMOKE_ACK=isolated-nonproduction-swarm bash "$script" 2>&1)" && {
  echo "FAIL: refused neither live Swarm services nor production workload" >&2
  exit 1
}
[[ "$output" == *"existing Swarm services"* ]] || {
  echo "FAIL: expected nonproduction invariant: $output" >&2
  exit 1
}
if PATH="$tmp:$PATH" RP_GPU_SMOKE_ACK='' bash "$script" >/dev/null 2>&1; then
  echo 'FAIL: empty acknowledge did not block smoke' >&2
  exit 1
fi
echo 'PASS: physical GPU smoke never mutates a production-like Swarm'
