#!/usr/bin/env bash
# Completely isolated, real ZITADEL v4 HTTPS tenant-project E2E.
# DO NOT point this test at any customer environment.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
compose=(docker compose -f test/federation/docker-compose.yml -f test/tenant-oidc/docker-compose.yml)
cleanup() {
  local exit_code=$?
  if ((exit_code != 0)); then
    echo "Isolated HTTPS ZITADEL E2E failed (redacted container log tail):" >&2
    "${compose[@]}" ps >&2 || true
    "${compose[@]}" logs --no-color --tail 25 zitadel >&2 || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f .env
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

[[ "${TENANT_OIDC_E2E_ISOLATED:-}" == true ]] || {
  echo "Run only with TENANT_OIDC_E2E_ISOLATED=true on isolated GitHub runner" >&2
  exit 2
}
[[ "${GITHUB_ACTIONS:-}" == true ]] || {
  echo "This destructive integration requires an ephemeral GitHub Actions runner" >&2
  exit 2
}
mkdir -p var/federation/zitadel/tls
chmod 700 var/federation/zitadel/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout var/federation/zitadel/tls/issuer.key \
  -out var/federation/zitadel/tls/issuer.crt \
  -subj "/CN=localhost/O=RP ephemeral E2E" \
  -addext "subjectAltName=DNS:localhost" \
  -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1
chmod 644 var/federation/zitadel/tls/issuer.crt
chmod 600 var/federation/zitadel/tls/issuer.key

export NODE_EXTRA_CA_CERTS="$root/var/federation/zitadel/tls/issuer.crt"
export ZITADEL_VERSION=v4.19.5
"${compose[@]}" up -d rp-postgres zitadel-postgres zitadel
ok=false
for ((attempt=0; attempt<120; attempt++)); do
  if curl --cacert "$NODE_EXTRA_CA_CERTS" -fsS \
    https://localhost:8443/debug/healthz >/dev/null 2>&1; then
    ok=true
    break
  fi
  sleep 2
done
[[ "$ok" == true ]] || {
  echo "Real HTTPS ZITADEL issuer did not become ready" >&2
  exit 1
}
cat >.env <<EOF
NODE_ENV=test
DATABASE_URL=postgresql://resource_portal:resource_portal@localhost:55432/resource_portal?schema=public
AUTH_MODE=dev
OIDC_ISSUER_URL=https://localhost:8443
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_AUDIENCE=
OIDC_PROVIDER_TYPE=zitadel
OIDC_REDIRECT_URI=https://localhost:8443/auth/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://localhost:8443/auth/logout
ZITADEL_MANAGEMENT_URL=https://localhost:8443
ZITADEL_ORGANIZATION_ID=
ZITADEL_PROJECT_ID=
ZITADEL_BOOTSTRAP_PAT_FILE=$root/var/federation/zitadel/admin.pat
ZITADEL_BOOTSTRAP_ORGANIZATION_NAME="RP Isolated Test"
ZITADEL_BOOTSTRAP_PROJECT_NAME="RP Isolated Test"
ZITADEL_BOOTSTRAP_APP_NAME="RP Tenant HTTPS Test"
ZITADEL_BOOTSTRAP_REDIRECT_URIS=https://localhost:8443/auth/callback
ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS=https://localhost:8443/auth/logout
ZITADEL_BOOTSTRAP_TEST_USER_USERNAME=tenant-oidc-bootstrap
ZITADEL_BOOTSTRAP_TEST_USER_EMAIL=bootstrap@example.test
ZITADEL_BOOTSTRAP_TEST_USER_PASSWORD=TestOnlyE2ePass!123
EOF

npm --workspace @resource-portal/api run zitadel:bootstrap
set -a
# shellcheck disable=SC1091
source "$root/.env"
set +a
export TENANT_OIDC_E2E_ISOLATED=true
export ZITADEL_MANAGEMENT_TOKEN="$(tr -d '\r\n' <"$root/var/federation/zitadel/admin.pat")"

# Provision DCR only on the disposable GitHub-hosted test issuer. The real
# MCP registration proof sends an anonymous RFC 7591 request, so this
# fixture needs open registration. Never apply this policy to a shared issuer.
node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  const issuer = 'https://localhost:8443';
  assert.equal(process.env.TENANT_OIDC_E2E_ISOLATED, 'true');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  const discoveryUrl = issuer + '/.well-known/openid-configuration';
  const getDiscovery = async () => {
    const response = await fetch(discoveryUrl, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json' },
    });
    assert.equal(response.status, 200, 'Isolated ZITADEL discovery must return HTTP 200');
    const discovery = await response.json();
    assert.equal(discovery.issuer, issuer, 'Isolated ZITADEL issuer mismatch');
    return discovery;
  };
  await getDiscovery();
  const pat = (await fs.readFile('var/federation/zitadel/admin.pat', 'utf8')).trim();
  assert.ok(pat.length > 0 && !/\s/.test(pat), 'Missing or invalid isolated bootstrap PAT');
  const settings = await fetch(issuer + '/v2/settings/security', {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + pat, 'content-type': 'application/json' },
    body: JSON.stringify({
      dynamicClientRegistration: { enabled: true, allowUnauthenticated: true },
    }),
  });
  assert.equal(settings.status, 200, 'Isolated ZITADEL DCR bootstrap failed');
  // The policy event is projected asynchronously. Keep the real discovery
  // prerequisite fail-closed, with bounded polling rather than a fixed sleep.
  for (let attempt = 0; attempt < 30; attempt++) {
    const discovery = await getDiscovery();
    if (discovery.registration_endpoint === issuer + '/oauth/v2/register') {
      console.log('PASS: isolated HTTPS issuer advertises its exact OAuth DCR endpoint.');
      return;
    }
    await delay(1000);
  }
  throw new Error('Isolated ZITADEL DCR endpoint not advertised after bootstrap');
})().catch(error => {
  // Do not expose administrative bearer or provider response bodies.
  console.error('BLOCKED: isolated HTTPS DCR bootstrap failed:', error.message);
  process.exitCode = 1;
});
NODE

(
  cd packages/resourceportal-api
  npx prisma migrate deploy
  npx ts-node --files scripts/tenant-oidc-live-e2e.ts
)
