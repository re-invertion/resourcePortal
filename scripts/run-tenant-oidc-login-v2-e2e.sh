#!/usr/bin/env bash
# Disposable GitHub-hosted ONLY; never touch an active Swarm or user sessions.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted &&
   "${RP_LOGIN_V2_E2E_ISOLATED:-}" == true &&
   "${ZITADEL_VERSION:-}" == v4.19.5 ]] || {
  echo 'Refusing to run non-isolated or unpatched Login V2 test' >&2; exit 2;
}
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != active ]] || {
  echo 'Refusing active Docker Swarm' >&2; exit 2;
}
export COMPOSE_PROJECT_NAME=rp532-login-v2-ci
compose=(docker compose -f test/federation/docker-compose.yml -f test/tenant-oidc-login-v2/docker-compose.yml)
proxy_pid=""
cleanup() {
  local code=$?
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f var/federation/zitadel/login-client.pat
  exit "$code"
}
trap cleanup EXIT INT TERM
mkdir -p var/federation/zitadel/tls
chmod 700 var/federation/zitadel/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout var/federation/zitadel/tls/issuer.key \
  -out var/federation/zitadel/tls/issuer.crt \
  -subj '/CN=localhost/O=RP disposable Login V2 E2E' \
  -addext 'subjectAltName=DNS:localhost' \
  -addext 'basicConstraints=critical,CA:TRUE' >/dev/null 2>&1
chmod 600 var/federation/zitadel/tls/issuer.key
export NODE_EXTRA_CA_CERTS="$root/var/federation/zitadel/tls/issuer.crt"
export LOGIN_SESSION_COOKIE_SECRET="$(openssl rand -hex 32)"
"${compose[@]}" up -d zitadel-postgres zitadel
node scripts/tenant-oidc-login-v2-proxy.cjs &
proxy_pid=$!
ready=false
for ((i=0;i<120;i++)); do
  if curl --cacert "$NODE_EXTRA_CA_CERTS" -fsS --max-time 3 \
    https://localhost:8443/debug/healthz >/dev/null 2>&1 &&
     [[ -s var/federation/zitadel/login-client.pat &&
        -s var/federation/zitadel/admin.pat ]]; then
    ready=true; break
  fi
  sleep 2
done
[[ "$ready" == true ]] || {
  echo 'Isolated API or IAM_LOGIN_CLIENT PAT did not become ready' >&2; exit 1;
}
"${compose[@]}" up -d zitadel-login
healthy=false
for ((i=0;i<90;i++)); do
  if curl --cacert "$NODE_EXTRA_CA_CERTS" -fsS --max-time 3 \
    https://localhost:8443/ui/v2/login/healthy >/dev/null 2>&1; then
    healthy=true; break
  fi
  sleep 2
done
[[ "$healthy" == true ]] || {
  echo 'Real Login V2 container unavailable behind HTTPS router' >&2; exit 1;
}
node test/tenant-oidc-login-v2/smoke.cjs
