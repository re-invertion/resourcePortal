#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "--only-values" || "${2:-}" != "-n" || "${3:-}" != "ceph.quota.max_bytes" || -z "${4:-}" ]]; then
  printf 'unsupported fake getxattr arguments: %s\n' "$*" >&2
  exit 64
fi

path="$4"
state_dir="${RP_FAKE_CEPH_QUOTA_STATE_DIR:-/tmp/resource-portal/fake-ceph-quota}"
key="$(printf '%s' "$path" | sha256sum | awk '{print $1}')"
cat "$state_dir/$key"
