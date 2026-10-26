#!/usr/bin/env bash
set -euo pipefail
# Real iproute2 in a fresh Linux tenant-style network namespace.
command -v ip >/dev/null
command -v nsenter >/dev/null
sudo -n true
ns="rp-lan-static-$$"
cleanup() { sudo -n ip netns delete "$ns" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -n ip netns add "$ns"
export RP_TEST_STATIC_NETNS="/var/run/netns/$ns"
npm exec --workspace @resource-portal/api -- vitest run src/networking/remote-lan-static-routing.nsenter.spec.ts
