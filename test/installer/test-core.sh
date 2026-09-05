#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/common.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/system.sh"
# shellcheck source=/dev/null
source "$repo_root/scripts/installer/config.sh"

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

assert_status() {
  local expected="$1" name="$2"
  shift 2
  set +e
  "$@" >/tmp/rp-installer-test.out 2>/tmp/rp-installer-test.err
  local actual=$?
  set -e
  assert_eq "$expected" "$actual" "$name"
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

assert_eq "debian:12" "$(rp_detect_os_text $'ID=debian\nVERSION_ID="12"')" "detect Debian 12"
assert_eq "debian:13" "$(rp_detect_os_text $'ID=debian\nVERSION_ID=13')" "detect Debian 13"
assert_eq "ubuntu:24.04" "$(rp_detect_os_text $'ID=ubuntu\nVERSION_ID="24.04"')" "detect Ubuntu 24.04"
assert_eq "ubuntu:26.04" "$(rp_detect_os_text $'ID=ubuntu\nVERSION_ID="26.04"')" "detect Ubuntu 26.04"
assert_status 0 "supported Debian 12" rp_os_supported debian 12
assert_status 0 "supported Ubuntu 26.04" rp_os_supported ubuntu 26.04
assert_status 1 "reject unsupported Ubuntu 22.04" rp_os_supported ubuntu 22.04
assert_status 1 "reject unsupported Fedora" rp_os_supported fedora 42

assert_status 0 "version equal" rp_version_ge 29.0.0 29.0.0
assert_status 0 "version greater" rp_version_ge 29.1.3 29.0.0
assert_status 1 "version lower" rp_version_ge 28.9.9 29.0.0
assert_status 0 "version handles missing patch" rp_version_ge 29.1 29.1.0
assert_status 1 "version compares major first" rp_version_ge 28.99.99 29.0.0

assert_status 0 "root preflight accepts uid 0" rp_require_root_uid 0
assert_status 1 "root preflight rejects non-root" rp_require_root_uid 1000

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
config_path="$tmpdir/installer.conf"
export RP_CFG_MODE="primary"
export RP_CFG_STORAGE_BASE_PATH="/srv/resource-portal/storage"
export RP_CFG_SWARM_ADVERTISE_ADDR="10.10.0.10"
export RP_CFG_DOMAIN="rp.example.com"
export RP_CFG_API_IMAGE="ghcr.io/example/api@sha256:abc"
export RP_CFG_WEB_IMAGE="ghcr.io/example/web@sha256:def"
export RP_SECRET_DATABASE_PASSWORD="super-secret-db-password"
export RP_CFG_SMTP_PASSWORD="must-not-be-serialized"

rp_config_write "$config_path"
config_text="$(cat "$config_path")"
assert_contains "$config_text" 'RP_CFG_MODE=primary' "writes allow-listed mode"
assert_contains "$config_text" 'RP_CFG_STORAGE_BASE_PATH=/srv/resource-portal/storage' "writes storage base path"
assert_contains "$config_text" 'RP_CFG_DOMAIN=rp.example.com' "writes domain"
assert_not_contains "$config_text" 'super-secret-db-password' "does not serialize RP_SECRET values"
assert_not_contains "$config_text" 'must-not-be-serialized' "does not serialize secret-like cfg key"
assert_eq "600" "$(stat -c '%a' "$config_path")" "config permissions are 0600"

unset RP_CFG_MODE RP_CFG_STORAGE_BASE_PATH RP_CFG_SWARM_ADVERTISE_ADDR RP_CFG_DOMAIN RP_CFG_API_IMAGE RP_CFG_WEB_IMAGE RP_SECRET_DATABASE_PASSWORD RP_CFG_SMTP_PASSWORD
rp_config_load "$config_path"
assert_eq "primary" "${RP_CFG_MODE:-}" "loads persisted mode"
assert_eq "/srv/resource-portal/storage" "${RP_CFG_STORAGE_BASE_PATH:-}" "loads persisted base path"
assert_eq "rp.example.com" "${RP_CFG_DOMAIN:-}" "loads persisted domain"

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi

printf 'All installer core tests passed.\n'
