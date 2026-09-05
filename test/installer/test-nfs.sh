#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/common.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/quota.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/nfs.sh"

failures=0
assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: %s\nunexpected: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else
    printf 'PASS: %s\n' "$name"
  fi
}
assert_status() {
  local expected="$1" name="$2"
  shift 2
  set +e
  "$@" >/tmp/rp-installer-nfs.out 2>/tmp/rp-installer-nfs.err
  local actual=$?
  set -e
  assert_eq "$expected" "$actual" "$name"
}

cfg="$(rp_render_ganesha_config /srv/resource-portal/storage '10.20.0.0/24' '10.20.0.11,10.20.0.12')"
assert_contains "$cfg" 'Path = "/srv/resource-portal/storage/volumes";' "volumes physical path"
assert_contains "$cfg" 'Pseudo = "/resourceportal/volumes";' "volumes pseudo path"
assert_contains "$cfg" 'Squash = Root_Squash;' "workload export root squash"
assert_contains "$cfg" 'Path = "/srv/resource-portal/storage/secrets";' "secrets export isolated"
assert_contains "$cfg" 'Pseudo = "/resourceportal/secrets";' "secrets pseudo isolated"
assert_contains "$cfg" 'Path = "/srv/resource-portal/storage/platform";' "platform export isolated"
assert_contains "$cfg" 'Pseudo = "/resourceportal/platform";' "platform pseudo isolated"
assert_contains "$cfg" 'Clients = 10.20.0.0/24;' "workload CIDR applies to volumes"
assert_contains "$cfg" 'Clients = 10.20.0.11,10.20.0.12;' "manager clients apply to protected exports"
assert_not_contains "$(rp_render_ganesha_export volumes /srv/resource-portal/storage '10.20.0.0/24')" '/platform' "volume export never exposes platform"
assert_not_contains "$(rp_render_ganesha_export volumes /srv/resource-portal/storage '10.20.0.0/24')" '/secrets' "volume export never exposes secrets"

assert_eq '10.20.0.10:/resourceportal/volumes /mnt/resourceportal/volumes nfs4 rw,hard,_netdev,noatime 0 0' \
  "$(rp_render_nfs_fstab_entry 10.20.0.10 volumes)" "render NFS volumes mount"
assert_eq '/srv/resource-portal/storage/platform /mnt/resourceportal/platform none bind 0 0' \
  "$(rp_render_local_bind_fstab_entry /srv/resource-portal/storage platform)" "render local platform bind"
assert_status 1 "reject unknown NFS namespace" rp_render_nfs_fstab_entry 10.20.0.10 databases

args="$(rp_storage_label_args true false true)"
assert_contains "$args" '--label-add resourceportal.storage.volumes=true' "volumes label when ready"
assert_contains "$args" '--label-add resourceportal.storage.platform=true' "platform label when ready"
assert_not_contains "$args" 'resourceportal.storage.secrets=true' "no secrets label when not ready"

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer NFS tests passed.\n'
