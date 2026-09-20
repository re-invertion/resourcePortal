#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/upgrade.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || { printf 'expected=%q actual=%q\n' "$1" "$2" >&2; fail "$3"; }; }

lifecycle_source="$(cat "$repo_root/scripts/installer/lifecycle.sh")"
reconfigure_source="$(cat "$repo_root/scripts/installer/reconfigure.sh")"
upgrade_source="$(cat "$repo_root/scripts/installer/upgrade.sh")"

contains "$lifecycle_source" '--label-add rp.node.control-plane=true' 'fresh primary receives v0.2 control-plane role'
contains "$lifecycle_source" '--label-add rp.node.ingress=true' 'fresh primary receives v0.2 ingress role'
contains "$lifecycle_source" '--label-add rp.node.tenant-workloads=true' 'fresh primary opts into v0.2 tenant workloads'
contains "$lifecycle_source" '--label-add resourceportal.control-plane=true' 'fresh primary retains legacy control-plane compatibility label'
contains "$reconfigure_source" 'rp_reconfigure_manager_label rp.node.control-plane resourceportal.control-plane' 'control-plane reconfigure updates new and legacy labels together'
contains "$reconfigure_source" 'rp_reconfigure_manager_label rp.node.ingress resourceportal.ingress' 'ingress reconfigure updates new and legacy labels together'
contains "$reconfigure_source" 'rp_reconfigure_node_label rp.node.tenant-workloads resourceportal.tenant-workloads' 'tenant workload reconfigure updates new and legacy labels together'
contains "$upgrade_source" 'rp_upgrade_ensure_v020_node_labels "$(rp_manifest_value "$manifest" '\''.version'\'')" || return 1' 'upgrade backfills v0.2 labels'
label_backfill_line="$(grep -n 'rp_upgrade_ensure_v020_node_labels.*manifest' "$repo_root/scripts/installer/upgrade.sh" | tail -n1 | cut -d: -f1)"
migration_line="$(grep -n 'if ! rp_run_migrations' "$repo_root/scripts/installer/upgrade.sh" | head -n1 | cut -d: -f1)"
if [[ -n "$label_backfill_line" && -n "$migration_line" && "$label_backfill_line" -lt "$migration_line" ]]; then
  pass 'v0.2 node labels are backfilled before migrations and stack deploy'
else
  fail 'v0.2 node labels are backfilled before migrations and stack deploy'
fi

calls="$(mktemp /tmp/rp-v020-placement.XXXXXX)"
: >"$calls"

label_value() {
  local node="$1" label="$2"
  case "${node}|${label}" in
    node-a\|resourceportal.tenant-workloads) printf '<no value>\n' ;;
    node-a\|resourceportal.control-plane) printf 'true\n' ;;
    node-a\|resourceportal.ingress) printf 'true\n' ;;
    node-a\|resourceportal.storage.authoritative) printf '<no value>\n' ;;
    node-a\|resourceportal.storage.volumes) printf 'true\n' ;;
    node-a\|resourceportal.storage.secrets) printf '<no value>\n' ;;
    node-a\|resourceportal.storage.platform) printf '<no value>\n' ;;
    node-a\|rp.node.tenant-workloads|node-a\|rp.node.control-plane|node-a\|rp.node.ingress|node-a\|rp.node.storage) printf '<no value>\n' ;;

    node-b\|resourceportal.tenant-workloads) printf 'false\n' ;;
    node-b\|resourceportal.control-plane|node-b\|resourceportal.ingress) printf '<no value>\n' ;;
    node-b\|resourceportal.storage.authoritative|node-b\|resourceportal.storage.volumes|node-b\|resourceportal.storage.secrets) printf '<no value>\n' ;;
    node-b\|resourceportal.storage.platform) printf 'true\n' ;;
    node-b\|rp.node.tenant-workloads|node-b\|rp.node.control-plane|node-b\|rp.node.ingress|node-b\|rp.node.storage) printf '<no value>\n' ;;

    node-c\|resourceportal.tenant-workloads) printf 'true\n' ;;
    node-c\|resourceportal.control-plane) printf 'true\n' ;;
    node-c\|resourceportal.ingress) printf '<no value>\n' ;;
    node-c\|resourceportal.storage.authoritative) printf '<no value>\n' ;;
    node-c\|resourceportal.storage.volumes) printf 'true\n' ;;
    node-c\|resourceportal.storage.secrets|node-c\|resourceportal.storage.platform) printf '<no value>\n' ;;
    node-c\|rp.node.tenant-workloads|node-c\|rp.node.control-plane|node-c\|rp.node.storage) printf 'true\n' ;;
    node-c\|rp.node.ingress) printf '<no value>\n' ;;
    *) printf '<no value>\n' ;;
  esac
}

docker() {
  if [[ "$1 $2" == 'node ls' ]]; then
    printf 'node-a\nnode-b\nnode-c\n'
    return 0
  fi
  if [[ "$1 $2" == 'node inspect' ]]; then
    local node="$3" template="${5:-}" label=''
    case "$template" in
      *'"resourceportal.tenant-workloads"'*) label='resourceportal.tenant-workloads' ;;
      *'"resourceportal.control-plane"'*) label='resourceportal.control-plane' ;;
      *'"resourceportal.ingress"'*) label='resourceportal.ingress' ;;
      *'"resourceportal.storage.authoritative"'*) label='resourceportal.storage.authoritative' ;;
      *'"resourceportal.storage.volumes"'*) label='resourceportal.storage.volumes' ;;
      *'"resourceportal.storage.secrets"'*) label='resourceportal.storage.secrets' ;;
      *'"resourceportal.storage.platform"'*) label='resourceportal.storage.platform' ;;
      *'"rp.node.tenant-workloads"'*) label='rp.node.tenant-workloads' ;;
      *'"rp.node.control-plane"'*) label='rp.node.control-plane' ;;
      *'"rp.node.ingress"'*) label='rp.node.ingress' ;;
      *'"rp.node.storage"'*) label='rp.node.storage' ;;
      *) return 1 ;;
    esac
    label_value "$node" "$label"
    return 0
  fi
  if [[ "$1 $2" == 'node update' ]]; then
    printf '%s\n' "$*" >>"$calls"
    return 0
  fi
  return 1
}

rp_upgrade_ensure_v020_node_labels '0.2.0'
expected=$'node update --label-add resourceportal.tenant-workloads=true --label-add rp.node.tenant-workloads=true node-a\nnode update --label-add rp.node.control-plane=true node-a\nnode update --label-add rp.node.ingress=true node-a\nnode update --label-add rp.node.storage=true node-a\nnode update --label-add rp.node.tenant-workloads=false node-b\nnode update --label-add rp.node.storage=true node-b'
eq "$expected" "$(cat "$calls")" 'v0.2 upgrade backfills roles without changing explicit opt-outs or already-migrated nodes'

: >"$calls"
rp_upgrade_ensure_v020_node_labels '0.1.10'
eq '' "$(cat "$calls")" 'pre-v0.2 upgrade does not alter node capabilities'

rm -f "$calls"
if (( failures > 0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All v0.2 placement/networking installer tests passed.\n'
