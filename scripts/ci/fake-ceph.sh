#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  health)
    printf '%s\n' '{"status":"HEALTH_OK"}'
    ;;
  df)
    printf '%s\n' '{"stats":{"total_bytes":1099511627776,"total_avail_bytes":1099511627776}}'
    ;;
  *)
    printf 'unsupported fake ceph command: %s\n' "$*" >&2
    exit 64
    ;;
esac
