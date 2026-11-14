#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Some independent CI jobs run test:installer immediately after npm ci,
# without running the API build first. The TLS regression must verify the
# actual shipped JavaScript, but must never silently reuse a stale artifact.
# Build only when absent or older than its OIDC source, so normal release
# gates that have already compiled the API do not waste another build.
api_dist="$repo_root/packages/resourceportal-api/dist/src/auth/oidc-auth.service.js"
transport_dist="$repo_root/packages/resourceportal-api/dist/src/auth/oidc-issuer-transport.js"
if [[ ! -r "$api_dist" || ! -r "$transport_dist" ||
      "$repo_root/packages/resourceportal-api/src/auth/oidc-auth.service.ts" -nt "$api_dist" ||
      "$repo_root/packages/resourceportal-api/src/auth/oidc-issuer-transport.ts" -nt "$transport_dist" ]]; then
  printf 'OIDC private-TLS smoke: building missing or stale API runtime.\n'
  (cd "$repo_root"; npm run build --workspace @resource-portal/api)
fi
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
