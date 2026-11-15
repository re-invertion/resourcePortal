#!/usr/bin/env bash
# One-off isolated live proof for #460; never point this at a production issuer.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == true && "$RP_460_ISOLATED" == true ]] || {
  echo 'Refusing to run outside isolated GitHub runner' >&2; exit 1;
}
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
umask 077
tmp="$(mktemp -d "$RUNNER_TEMP/rp-460-live.XXXXXX")"
traefik_service="rp-460-oneoff-traefik"
api_pid=''
probe_pid=''
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$probe_pid" ]]; then kill "$probe_pid" 2>/dev/null || true; fi
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
  docker service rm "$traefik_service" >/dev/null 2>&1 || true
  docker rm -f rp-460-oneoff-registry >/dev/null 2>&1 || true
  bash scripts/run-federation-e2e.sh cleanup >/dev/null 2>&1 || true
  docker swarm leave --force >/dev/null 2>&1 || true
  if (( code != 0 )); then
    echo 'Live #460 fixture failed; last API messages:' >&2
    tail -n 50 "$tmp/api.log" >&2 2>/dev/null || true
    docker service ps "$traefik_service" --no-trunc >&2 2>/dev/null || true
  fi
  rm -rf -- "$tmp"
  exit "$code"
}
trap cleanup EXIT

# Use the exact real ZITADEL v4 instance, DB, bootstrap PAT and API build
# already exercised by the repo's live federation suite.
bash scripts/run-federation-e2e.sh services
# Actions V2 validates DNS during target creation. Unlike the runner's own
# /etc/hosts, a container has an independent hosts file even in host network
# mode. Provide an explicit ONE-OFF hostname binding to the real loopback
# Traefik listener, using only this disposable ZITADEL container. Do not
# change production DNS, bypass DNS rebinding checks, or use external tunnels.
cat >"$tmp/zitadel-hosts.yml" <<'YAML'
services:
  zitadel:
    extra_hosts:
      - "rp-callback.test:127.0.0.1"
YAML
docker compose -f test/federation/docker-compose.yml -f "$tmp/zitadel-hosts.yml" \
  up -d --no-deps --force-recreate zitadel
for attempt in $(seq 1 90); do
  if curl --fail --silent http://localhost:8080/debug/healthz >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error http://localhost:8080/debug/healthz >/dev/null
docker exec federation-zitadel-1 getent hosts rp-callback.test | grep -F '127.0.0.1' >/dev/null
echo 'PASS: isolated ZITADEL DNS resolves test callback to loopback'
bash scripts/run-federation-e2e.sh bootstrap
bash scripts/run-federation-e2e.sh database
bash scripts/run-federation-e2e.sh build
set -a
# shellcheck disable=SC1091
source .env
set +a
[[ -s var/federation/zitadel/admin.pat && "$ZITADEL_ORGANIZATION_ID" =~ ^[0-9]+$ ]] || exit 1
printf 'header = "Authorization: Bearer %s"\nheader = "x-zitadel-orgid: %s"\n' \
  "$(tr -d '\r\n' <var/federation/zitadel/admin.pat)" "$ZITADEL_ORGANIZATION_ID" >"$tmp/management.conf"
chmod 0600 "$tmp/management.conf"

# Real ZITADEL Actions V2 target. ZITADEL uses ExternalDomain=localhost
# for instance selection; HTTP Host 127.0.0.1:8080 returns instance-not-found.
# Read back its signing secret from the
# isolated ZITADEL database, not a fabricated key.
cat >"$tmp/target.json" <<'JSON'
{"name":"rp-460-oneoff-action","endpoint":"https://rp-callback.test/api/app-consumer-actions/preaccesstoken","timeout":"5s","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}
JSON
# Probe the READ-ONLY Actions V2 search route before any non-idempotent
# POST /targets. A 404 on target creation must not be retried blindly.
printf '{"pagination":{"limit":1}}' >"$tmp/target-search.json"
search_http="$(curl --silent --show-error --config "$tmp/management.conf" \
  --request POST --header 'Content-Type: application/json' \
  --data-binary "@$tmp/target-search.json" \
  --output "$tmp/target-search-response.json" --write-out '%{http_code}' \
  http://localhost:8080/v2/actions/targets/search)"
echo "Isolated ZITADEL Actions V2 target search HTTP=$search_http"
if [[ "$search_http" != 200 ]]; then
  echo "Actions V2 management route unavailable; diagnostic (not production):" >&2
  head -c 1500 "$tmp/target-search-response.json" >&2
  echo >&2
  exit 1
fi
create_http="$(curl --silent --show-error --config "$tmp/management.conf" \
  --request POST --header 'Content-Type: application/json' \
  --data-binary "@$tmp/target.json" \
  --output "$tmp/target-created.json" --write-out '%{http_code}' \
  http://localhost:8080/v2/actions/targets)"
echo "Isolated ZITADEL Actions V2 target CREATE HTTP=$create_http"
if [[ "$create_http" != 200 ]]; then
  echo "CreateTarget rejected. No retry of non-idempotent mutation." >&2
  head -c 1500 "$tmp/target-created.json" >&2
  echo >&2
  exit 1
fi
target_id="$(jq -er '.id | select(type=="string" and test("^[0-9]{1,64}$"))' "$tmp/target-created.json")"
jq -er '.signingKey | select(type=="string" and length>=32)' "$tmp/target-created.json" >"$tmp/action.key"
# jq appends a newline; production secret bytes never contain it.
truncate -s -1 "$tmp/action.key"
# ZITADEL serves management GET through asynchronous projections.
# The immediately preceding target POST can succeed before its GET is visible.
# Retry only 404 and 503 for the bounded read; fail closed on other statuses.
readback_code=''
for attempt in $(seq 1 20); do
  readback_code="$(curl --silent --show-error --config "$tmp/management.conf" \
    --output "$tmp/readback.json" --write-out '%{http_code}' \
    "http://localhost:8080/v2/actions/targets/$target_id")"
  echo "ZITADEL Actions target readback attempt=$attempt HTTP=$readback_code"
  if [[ "$readback_code" == 200 ]]; then break; fi
  if [[ "$readback_code" != 404 && "$readback_code" != 503 ]]; then
    echo "Unexpected ZITADEL Actions readback HTTP $readback_code" >&2
    exit 1
  fi
  sleep 2
done
if [[ "$readback_code" != 200 ]]; then
  echo "ZITADEL target did not appear after 40s; last HTTP=$readback_code" >&2
  exit 1
fi
jq -e --arg id "$target_id" --arg url 'https://rp-callback.test/api/app-consumer-actions/preaccesstoken' \
  --rawfile key "$tmp/action.key" \
  '.target.id==$id and .target.endpoint==$url and
   .target.payloadType=="PAYLOAD_TYPE_JSON" and
   .target.restWebhook.interruptOnError==true and .target.signingKey==$key' \
  "$tmp/readback.json" >/dev/null

# Actual independent Docker Swarm; Traefik is a real Swarm service.
docker swarm init
docker run --detach --name rp-460-oneoff-registry --publish 127.0.0.1:5000:5000 registry:2 >/dev/null
# Build the exact PR's production API image and publish ONLY to local registry
# so the production signer can use its mandatory immutable image digest.
docker build -t localhost:5000/rp-460-signer:oneoff .
docker push localhost:5000/rp-460-signer:oneoff
export RP_CFG_API_IMAGE
RP_CFG_API_IMAGE="$(docker image inspect localhost:5000/rp-460-signer:oneoff --format '{{index .RepoDigests 0}}')"
[[ "$RP_CFG_API_IMAGE" =~ ^localhost:5000/rp-460-signer@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Immutable local signer digest unavailable' >&2; exit 1;
}
source scripts/installer/secrets.sh
export RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF
RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF="$(rp_versioned_secret_name rp_app_consumer_action_hmac "$tmp/action.key")"
docker secret create "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" - <"$tmp/action.key" >/dev/null
docker secret inspect "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" >/dev/null

# A throwaway CA is trusted by system curl; never use -k or disable TLS.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=rp-callback.test' \
  -addext 'subjectAltName=DNS:rp-callback.test' \
  -keyout "$tmp/tls.key" -out "$tmp/tls.crt" >/dev/null 2>&1
sudo cp "$tmp/tls.crt" /usr/local/share/ca-certificates/rp-460-oneoff.crt
sudo update-ca-certificates >/dev/null
echo '127.0.0.1 rp-callback.test' | sudo tee -a /etc/hosts >/dev/null
export NO_PROXY='rp-callback.test,localhost,127.0.0.1'
export no_proxy="$NO_PROXY"

# The callback is served by the REAL RP Nest API and its actual HMAC
# verification service. Set valid isolated invitation flags to satisfy the
# production global-action configuration checks.
export PUBLIC_API_URL='https://rp-callback.test'
export RP_APP_CONSUMER_ACTIONS_V2_ENABLED=true
export RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
export RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID="$target_id"
export RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL='https://rp-callback.test/api/app-consumer-actions/preaccesstoken'
export RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY_FILE="$tmp/action.key"
export RP_INVITATION_ONBOARDING_ENABLED=true
export OIDC_INVITATION_CLIENT_ID='rp-460-distinct-test-client'
export OIDC_INVITATION_CLIENT_SECRET='rp-460-ephemeral-invitation-secret-32-chars'
export OIDC_INVITATION_REDIRECT_URI='https://rp-callback.test/api/invitations/onboard/callback'
export ZITADEL_MANAGEMENT_TOKEN
ZITADEL_MANAGEMENT_TOKEN="$(tr -d '\r\n' <var/federation/zitadel/admin.pat)"
node packages/resourceportal-api/dist/src/main.js >"$tmp/api.log" 2>&1 &
api_pid=$!
for attempt in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:3000/api/health/live >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:3000/api/health/live >/dev/null

cat >"$tmp/traefik.yml" <<'YAML'
http:
  routers:
    callback:
      rule: "Host(`rp-callback.test`)"
      entryPoints: [websecure]
      tls: {}
      service: live-rp
  services:
    live-rp:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
tls:
  certificates:
    - certFile: /tls.crt
      keyFile: /tls.key
YAML
docker service create --detach=true --name "$traefik_service" \
  --network host --replicas 1 \
  --mount "type=bind,src=$tmp/traefik.yml,dst=/dynamic.yml,readonly" \
  --mount "type=bind,src=$tmp/tls.crt,dst=/tls.crt,readonly" \
  --mount "type=bind,src=$tmp/tls.key,dst=/tls.key,readonly" \
  traefik:v3.5.4 \
  --entrypoints.websecure.address=:443 \
  --providers.file.filename=/dynamic.yml \
  --log.level=INFO >/dev/null
for attempt in $(seq 1 90); do
  if curl --fail --silent --show-error 'https://rp-callback.test/api/health/live' >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --fail --silent --show-error 'https://rp-callback.test/api/health/live' >/dev/null
echo 'PASS: REAL Swarm Traefik HTTPS readiness using trusted certificate'

# Before activating any global execution, reject an unsigned POST via real RP.
unsigned_code="$(curl --silent --show-error --no-location --proto '=https' \
  -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"function":"function/preaccesstoken"}' \
  'https://rp-callback.test/api/app-consumer-actions/preaccesstoken')"
[[ "$unsigned_code" == 401 ]] || { echo "Unsigned callback returned $unsigned_code" >&2; exit 1; }

source scripts/installer/app-consumer-actions.sh
export RP_CFG_DOMAIN='rp-callback.test'
export RP_INSTALLER_STATE_DIR="$tmp/installer-state"
mkdir -p "$RP_INSTALLER_STATE_DIR"
# Only the management key lookup is supplied from authenticated REAL
# ZITADEL read-back; the PRODUCTION signer, curl and callback are unmodified.
rp_app_action_read_key() {
  [[ "$1" == "$target_id" && "$3" == "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" ]] || return 1
  cp -- "$tmp/action.key" "$2"
}

# Force actual Traefik listener loss AFTER initial HTTPS readiness.
docker service scale "$traefik_service=0" >/dev/null
for attempt in $(seq 1 40); do
  if ! curl --connect-timeout 1 --max-time 2 --silent --fail \
    'https://rp-callback.test/api/health/live' >/dev/null; then break; fi
  sleep 1
done
if curl --connect-timeout 1 --max-time 2 --silent --fail \
  'https://rp-callback.test/api/health/live' >/dev/null; then
  echo 'Cannot prove ingress is down' >&2; exit 1
fi
rp_app_action_probe "$target_id" "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" \
  >"$tmp/probe-out.log" 2>"$tmp/probe-err.log" &
probe_pid=$!
sleep 8
docker service scale "$traefik_service=1" >/dev/null
wait "$probe_pid"
probe_pid=''
grep -Eq 'curl=7 http=000|curl=7 http=' "$tmp/probe-err.log" || {
  cat "$tmp/probe-err.log" >&2
  echo 'No real curl 7 during ingress outage' >&2; exit 1;
}
grep -Eq 'curl=0 http=403' "$tmp/probe-err.log" || {
  cat "$tmp/probe-err.log" >&2
  echo 'No signed 403 after restored ingress' >&2; exit 1;
}
echo 'PASS: REAL >8s Traefik outage after HTTPS ready, curl 7 then signed 403'

# Bind the one test-owned target in the real ZITADEL instance, and verify
# exactly one preaccesstoken execution is present.
jq -n --arg id "$target_id" \
  '{condition:{function:{name:"preaccesstoken"}},targets:[$id]}' >"$tmp/execution.json"
curl --fail --silent --show-error --config "$tmp/management.conf" \
  --request PUT -H 'Content-Type: application/json' \
  --data-binary "@$tmp/execution.json" \
  http://localhost:8080/v2/actions/executions >"$tmp/bind.json"
printf '{"pagination":{"limit":100}}' >"$tmp/search.json"
curl --fail --silent --show-error --config "$tmp/management.conf" \
  --request POST -H 'Content-Type: application/json' \
  --data-binary "@$tmp/search.json" \
  http://localhost:8080/v2/actions/executions/search >"$tmp/executions.json"
jq -e --arg id "$target_id" \
  '[.executions[]? | select(.condition.function.name=="preaccesstoken")] as $e |
   ($e|length)==1 and $e[0].targets==[$id]' "$tmp/executions.json" >/dev/null
echo 'PASS: one real ZITADEL Actions V2 pre-token execution owned by test target'

# Separate persistent real-HTTPS outage test: no late success is accepted.
# This confirms the failure signal; the full installer DB restore is covered
# by Release Readiness but is NOT claimed as covered by this smoke.
docker service scale "$traefik_service=0" >/dev/null
for attempt in $(seq 1 40); do
  if ! curl --connect-timeout 1 --max-time 2 --silent --fail \
    'https://rp-callback.test/api/health/live' >/dev/null; then break; fi
  sleep 1
done
if rp_app_action_probe "$target_id" "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" \
  >"$tmp/fail-out.log" 2>"$tmp/fail-err.log"; then
  echo 'FAIL: persistent HTTPS loss incorrectly accepted' >&2; exit 1;
fi
grep -q 'timed out after 120s' "$tmp/fail-err.log" || {
  cat "$tmp/fail-err.log" >&2; echo 'FAIL: wrong persistent-outage decision' >&2; exit 1;
}
docker service scale "$traefik_service=1" >/dev/null
for attempt in $(seq 1 90); do
  if curl --fail --silent 'https://rp-callback.test/api/health/live' >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --fail --silent 'https://rp-callback.test/api/health/live' >/dev/null
echo 'PASS: persistent REAL HTTPS outage fails closed and API recovers after ingress restore'
echo 'NOTE: full installer-driven rollback after this exact outage still requires separate end-to-end evidence'
