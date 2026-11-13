#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
# Test certificate and key are ephemeral; never part of a release artifact.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=auth.rp-oidc-private.invalid' \
  -addext 'subjectAltName=DNS:auth.rp-oidc-private.invalid' \
  -keyout "$tmp/key.pem" -out "$tmp/ca.pem" >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$tmp/ca.pem"
export OIDC_TEST_CA_FILE="$tmp/ca.pem"
export OIDC_TEST_KEY_FILE="$tmp/key.pem"
node "$repo_root/test/installer/oidc-private-tls-smoke.cjs"
