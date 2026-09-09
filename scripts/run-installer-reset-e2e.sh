#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "${RP_RESET_E2E_DISPOSABLE:-}" == YES ]] || {
  printf '%s\n' 'Refusing destructive reset E2E: RP_RESET_E2E_DISPOSABLE=YES is required.' >&2
  exit 2
}
[[ "$(id -u)" == 0 ]] || {
  printf '%s\n' 'Destructive reset E2E must run as root.' >&2
  exit 2
}
[[ -n "${RP_RESET_E2E_STORAGE_DEVICE:-}" && -b "$RP_RESET_E2E_STORAGE_DEVICE" ]] || {
  printf '%s\n' 'RP_RESET_E2E_STORAGE_DEVICE must be an explicit block device.' >&2
  exit 2
}
[[ -r "${RP_RESET_E2E_CONFIG:-}" ]] || {
  printf '%s\n' 'RP_RESET_E2E_CONFIG must point to the installer config for this disposable host.' >&2
  exit 2
}

# The E2E config is installer-created root-only state on this disposable VM.
# shellcheck source=/dev/null
source "$RP_RESET_E2E_CONFIG"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/storage.sh"

configured_device="${RP_CFG_STORAGE_DEVICE:-}"
storage_mount="${RP_CFG_STORAGE_MOUNTPOINT:-${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}}"
stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
manifest=/var/lib/resourceportal/installer-state/owned-resources
manifest_copy=/tmp/resourceportal-reset-e2e-owned-resources.before
sentinel=/tmp/resourceportal-reset-e2e-unrelated-file
fstab_sentinel='# unrelated fstab sentinel'

rp_reset_e2e_assert_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then
    printf 'E2E assertion failed: expected path to be absent: %s\n' "$path" >&2
    return 1
  fi
}

rp_reset_e2e_assert_unmounted() {
  local target="$1"
  if findmnt -rn -M "$target" >/dev/null 2>&1; then
    printf 'E2E assertion failed: expected mountpoint to be absent: %s\n' "$target" >&2
    return 1
  fi
}

rp_reset_e2e_assert_no_signatures() {
  local device="$1"
  if wipefs -n "$device" 2>/dev/null | grep -q '[^[:space:]]'; then
    printf 'E2E assertion failed: storage signatures remain on %s\n' "$device" >&2
    return 1
  fi
}

rp_reset_e2e_assert_command_absent() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    printf 'E2E assertion failed: command still exists: %s\n' "$command_name" >&2
    return 1
  fi
}

rp_reset_e2e_assert_package_absent() {
  local package="$1"
  if dpkg-query -W -f='${db:Status-Abbrev}\n' "$package" 2>/dev/null | grep -q '^ii '; then
    printf 'E2E assertion failed: package still installed: %s\n' "$package" >&2
    return 1
  fi
}

test_device="$(readlink -f "$RP_RESET_E2E_STORAGE_DEVICE")"
[[ -n "$configured_device" ]] || {
  printf '%s\n' 'Installer config has no RP_CFG_STORAGE_DEVICE; refusing destructive E2E.' >&2
  exit 2
}
configured_device="$(readlink -f "$configured_device")"
[[ "$test_device" == "$configured_device" ]] || {
  printf 'E2E storage device %s does not match installer config %s.\n' "$test_device" "$configured_device" >&2
  exit 2
}

rp_storage_related_to_root "$test_device" || {
  printf 'Refusing destructive reset E2E on root/system-related storage: %s\n' "$test_device" >&2
  exit 2
}

while IFS= read -r node; do
  [[ -n "$node" ]] || continue
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    rp_storage_mount_target_allowed_for_resourceportal "$target" "$storage_mount" || {
      printf 'Storage device is mounted outside the approved ResourcePortal storage paths: %s -> %s\n' "$node" "$target" >&2
      exit 2
    }
  done < <(findmnt -rn -S "$node" -o TARGET 2>/dev/null || true)
done < <(lsblk -lnpo NAME "$test_device")

# Pre-reset proof: this must be a real installer-created single-node RP host.
docker info --format '{{.Swarm.LocalNodeState}}' | grep -qx active
docker service ls --format '{{.Name}}' | grep -q "^${stack}_"
test -r "$RP_RESET_E2E_CONFIG"
test -r "$manifest"
findmnt -rn -M "$storage_mount" >/dev/null

docker_was_owned=false
if grep -Fxq 'docker installed-by-resourceportal' "$manifest"; then docker_was_owned=true; fi

printf 'keep\n' >"$sentinel"
grep -Fxq "$fstab_sentinel" /etc/fstab || printf '%s\n' "$fstab_sentinel" >>/etc/fstab
cp "$manifest" "$manifest_copy"
chmod 0600 "$manifest_copy"

"$repo_root/resourceportal-install.sh" \
  --mode reset \
  --scope factory \
  --non-interactive \
  --confirm-factory-reset \
  --allow-destructive-storage \
  --config "$RP_RESET_E2E_CONFIG"

# Post-reset proof: RP state and storage are gone, unrelated host state survived.
rp_reset_e2e_assert_absent /etc/resourceportal
rp_reset_e2e_assert_absent /var/lib/resourceportal/installer-state
rp_reset_e2e_assert_absent /var/lib/resourceportal/reset-state/factory.state
rp_reset_e2e_assert_absent /var/lib/resourceportal/reset-state/factory.plan
rp_reset_e2e_assert_unmounted "$storage_mount"
rp_reset_e2e_assert_no_signatures "$test_device"
test "$(cat "$sentinel")" = keep
grep -Fxq "$fstab_sentinel" /etc/fstab

if [[ "$docker_was_owned" == true ]]; then
  rp_reset_e2e_assert_command_absent docker
  rp_reset_e2e_assert_absent /var/lib/docker
fi

while read -r type value; do
  [[ "$type" == package ]] || continue
  rp_reset_e2e_assert_package_absent "$value"
done <"$manifest_copy"

printf '%s\n' 'ResourcePortal factory-reset E2E passed on disposable host.'
