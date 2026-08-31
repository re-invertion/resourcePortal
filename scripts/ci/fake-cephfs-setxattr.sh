#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "-n" || "${2:-}" != "ceph.quota.max_bytes" || "${3:-}" != "-v" || -z "${4:-}" || -z "${5:-}" ]]; then
  printf 'unsupported fake setxattr arguments: %s\n' "$*" >&2
  exit 64
fi

value="$4"
path="$5"
state_dir="${RP_FAKE_CEPH_QUOTA_STATE_DIR:-/tmp/resource-portal/fake-ceph-quota}"
key="$(printf '%s' "$path" | sha256sum | awk '{print $1}')"
mkdir -p "$state_dir"
printf '%s\n' "$value" > "$state_dir/$key"
