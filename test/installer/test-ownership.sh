#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/ownership.sh"

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
  "$@" >/tmp/rp-installer-ownership.out 2>/tmp/rp-installer-ownership.err
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

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
manifest="$tmpdir/owned-resources"
RP_OWNERSHIP_MANIFEST="$manifest"
export RP_OWNERSHIP_MANIFEST

rp_ownership_record package nfs-ganesha
rp_ownership_record package nfs-ganesha
assert_eq 1 "$(grep -c '^package nfs-ganesha$' "$manifest")" 'ownership records are idempotent'
assert_eq 600 "$(stat -c '%a' "$manifest")" 'ownership manifest is root-only'
assert_status 0 'ownership lookup finds record' rp_ownership_has package nfs-ganesha
assert_eq 'nfs-ganesha' "$(rp_ownership_values package)" 'ownership values return only payload'
assert_status 1 'ownership rejects newline payload' rp_ownership_record package $'bad\nvalue'

dpkg-query() {
  if [[ "$3" == ca-certificates ]]; then
    printf 'ii \n'
    return 0
  fi
  if [[ "$3" == nfs-ganesha && -e "$tmpdir/after-install" ]]; then
    printf 'ii \n'
    return 0
  fi
  return 1
}
apt-get() {
  [[ "$1" == update ]] && return 0
  [[ "$1" == install ]] || return 1
  : >"$tmpdir/after-install"
}
rp_install_packages_with_ownership ca-certificates nfs-ganesha
assert_status 1 'pre-existing package is not claimed' rp_ownership_has package ca-certificates
assert_status 0 'new package is claimed' rp_ownership_has package nfs-ganesha
assert_eq 'nfs-ganesha' "$(rp_ownership_values package)" 'only newly installed package is recorded'
assert_contains "$(cat "$manifest")" 'package nfs-ganesha' 'manifest contains package metadata only'

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer ownership tests passed.\n'
