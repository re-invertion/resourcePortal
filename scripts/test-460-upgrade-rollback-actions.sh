#!/usr/bin/env bash
# One-off #460 real issuer integration: called from the production rollback
# smoke ONLY on an isolated GitHub runner with opt-in.
[[ "${GITHUB_ACTIONS:-}" == true && "${RP_ROLLBACK_E2E_ISOLATED:-}" == true &&
   "${RP_460_VERIFY_SAME_OUTAGE_ROLLBACK:-}" == true ]] || return 1
source "$repo_root/scripts/installer/app-consumer-actions.sh"
eval "$(declare -f rp_app_action_checkpoint_detach |
  sed '1s/rp_app_action_checkpoint_detach/rp460_original_action_detach/')"
export RP_CFG_DOMAIN=rp-callback.test RP_CFG_ACME_ENVIRONMENT=production
# The PUBLISHED source is not yet Actions V2 certified. Do not lie to the
# production rollback preflight: certify only the candidate after the real
# target and the same-ZITADEL-DB secret have been created.
export RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=false
export NO_PROXY=localhost,127.0.0.1,rp-callback.test
export no_proxy="$NO_PROXY"
umask 022
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=rp-callback.test' -addext 'subjectAltName=DNS:rp-callback.test' \
  -keyout "$root/rp460-tls.key" -out "$root/rp460-tls.crt" >/dev/null 2>&1
sudo cp "$root/rp460-tls.crt" /usr/local/share/ca-certificates/rp460-rollback.crt
sudo update-ca-certificates >/dev/null
echo '127.0.0.1 rp-callback.test' | sudo tee -a /etc/hosts >/dev/null
docker run -d --name rp460-rollback-registry -p 127.0.0.1:5000:5000 registry:2 >/dev/null
docker tag resourceportal-api-candidate localhost:5000/rp460-signer:oneoff
docker push localhost:5000/rp460-signer:oneoff >/dev/null
export RP_CFG_API_IMAGE="$(docker image inspect localhost:5000/rp460-signer:oneoff --format '{{index .RepoDigests 0}}')"
[[ "$RP_CFG_API_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || return 1

rp460_zitadel_http() {
  local method="$1" path="$2" out="$3" input="${4:-}" http
  [[ "$path" == /v2/actions/* ]] || return 1
  local -a args=(--silent --show-error --no-location --max-time 20
    --header 'Host: localhost:18080' --header 'Content-Type: application/json'
    --config "$root/rp460-management.conf" --output "$out"
    --write-out '%{http_code}' --request "$method")
  if [[ -n "$input" ]]; then args+=(--data-binary "@$input"); fi
  http="$(curl "${args[@]}" "http://127.0.0.1:18080$path")" || return 1
  if [[ "$http" != 200 ]]; then
    echo "ZITADEL $method $path HTTP=$http" >&2
    # ZITADEL management error is JSON; report status/code/message only, not
    # PAT, signature, target signing key or arbitrary response bytes.
    jq -c '{code, message, details}' "$out" >&2 2>/dev/null || true
    return 1
  fi
}
rp_app_action_http() { rp460_zitadel_http "$@"; }
rp_app_action_prepare() {
  # After both physical source DB snapshots, create a candidate-only target
  # in the same real ZITADEL eventstore that rp_upgrade_apply will restore.
  rp_rollback_zitadel_start "$candidate_zitadel" "candidate action provisioning" || return 1
  local pat="$root/zitadel-real-runtime/bootstrap/admin.pat"
  [[ -s "$pat" ]] || return 1
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\r\n' < "$pat")" \
    > "$root/rp460-management.conf"
  chmod 0600 "$root/rp460-management.conf"
  printf '%s\n' '{"name":"rp460-rollback","endpoint":"https://rp-callback.test/api/app-consumer-actions/preaccesstoken","timeout":"5s","payloadType":"PAYLOAD_TYPE_JSON","restWebhook":{"interruptOnError":true}}' > "$root/rp460-target.json"
  rp460_zitadel_http POST /v2/actions/targets "$root/rp460-created.json" "$root/rp460-target.json" || return 1
  local id attempt code
  id="$(jq -er '.id | select(type=="string" and test("^[0-9]{1,64}$"))' "$root/rp460-created.json")" || return 1
  jq -er '.signingKey | select(type=="string" and length>=32)' "$root/rp460-created.json" > "$root/rp460-action.key" || return 1
  truncate -s -1 "$root/rp460-action.key"
  chmod 0644 "$root/rp460-action.key"
  export RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID="$id"
  export RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
  export RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF="rp_app_consumer_action_hmac_$(sha256sum "$root/rp460-action.key" | cut -c1-16)"
  docker secret create "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" - <"$root/rp460-action.key" >/dev/null || return 1
  RP_APP_ACTION_UPGRADE_NEW=true
  export RP_APP_ACTION_UPGRADE_NEW
  for attempt in $(seq 1 20); do
    if rp460_zitadel_http GET "/v2/actions/targets/$id" "$root/rp460-readback.json"; then break; fi
    sleep 2
  done
  jq -e --arg id "$id" --rawfile k "$root/rp460-action.key" \
    '.target.id==$id and .target.signingKey==$k' "$root/rp460-readback.json" >/dev/null || return 1
  echo 'PASS: target created in the actual candidate ZITADEL database'
}
rp_app_action_read_key() {
  [[ "$1" == "$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" && "$3" == "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" ]] || return 1
  cp -- "$root/rp460-action.key" "$2" || return 1
  chmod 0711 "$(dirname "$2")" && chmod 0644 "$2"
}
rp460_start_api_and_ingress() {
  docker run -d --name rp460-candidate-api --network "$db_network" \
    -p 127.0.0.1:3000:3000 \
    -e DATABASE_URL="$compat_url" -e NODE_ENV=test -e PORT=3000 \
    -e AUTH_MODE=dev -e PUBLIC_API_URL=https://rp-callback.test \
    -e RESOURCE_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
    -e INTERNAL_WORKER_TOKEN=rollback-test-only \
    -e RP_APP_CONSUMER_ACTIONS_V2_ENABLED=true -e RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true \
    -e RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID="$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" \
    -e RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL=https://rp-callback.test/api/app-consumer-actions/preaccesstoken \
    -e RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY_FILE=/run/action-key \
    -e RP_INVITATION_ONBOARDING_ENABLED=true -e OIDC_INVITATION_CLIENT_ID=rp460-candidate-client \
    -e OIDC_INVITATION_CLIENT_SECRET=oneoff-invitation-secret-32-chars \
    -e OIDC_INVITATION_REDIRECT_URI=https://rp-callback.test/api/invitations/onboard/callback \
    --mount "type=bind,src=$root/rp460-action.key,dst=/run/action-key,readonly" \
    resourceportal-api-candidate >/dev/null || return 1
  cat > "$root/rp460-traefik.yml" <<'YAML'
http:
  routers:
    callback:
      rule: "Host(`rp-callback.test`)"
      entryPoints: [websecure]
      tls: {}
      service: api
  services:
    api:
      loadBalancer:
        servers:
          - url: http://127.0.0.1:3000
tls:
  certificates:
    - certFile: /tls.crt
      keyFile: /tls.key
YAML
  docker service create --detach=true --name rp460-rollback-traefik \
    --network host --replicas 1 \
    --mount "type=bind,src=$root/rp460-traefik.yml,dst=/dynamic.yml,readonly" \
    --mount "type=bind,src=$root/rp460-tls.crt,dst=/tls.crt,readonly" \
    --mount "type=bind,src=$root/rp460-tls.key,dst=/tls.key,readonly" \
    traefik:v3.5.4 --entrypoints.websecure.address=:443 \
    --providers.file.filename=/dynamic.yml >/dev/null || return 1
  for attempt in $(seq 1 90); do
    if curl --silent --fail --proto '=https' https://rp-callback.test/api/health/live >/dev/null 2>&1; then
      echo 'PASS: candidate API ready through real trusted Traefik HTTPS'
      return 0
    fi
    sleep 2
  done
  docker logs rp460-candidate-api --tail 50 >&2 || true
  return 1
}
health_checks=0
rp_wait_for_https_origin() {
  health_checks=$((health_checks+1))
  if [[ "$health_checks" == 1 ]]; then
    wait_services target && rp460_start_api_and_ingress
  else
    wait_services previous || return 1
    # Rollback health must be a genuine, TLS-validated request to the
    # PREVIOUS published API using the just-restored source PostgreSQL.
    docker run -d --name rp460-source-api --network "$db_network" \
      -p 127.0.0.1:3000:3000 -e DATABASE_URL="$compat_url" \
      -e NODE_ENV=test -e AUTH_MODE=dev -e PORT=3000 \
      -e PUBLIC_API_URL=https://rp-callback.test \
      -e RESOURCE_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY= \
      -e INTERNAL_WORKER_TOKEN=rollback-test-only "$source_api" >/dev/null || return 1
    local attempt ready=false
    for attempt in $(seq 1 90); do
      if curl --silent --fail --proto '=https' \
        https://rp-callback.test/api/health/ready >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 2
    done
    if [[ "$ready" != true ]]; then
      docker logs rp460-source-api --tail 50 >&2 || true
      return 1
    fi
    docker rm -f rp460-source-api >/dev/null || return 1
    echo 'PASS: source published API ready through restored HTTPS ingress'
  fi
}
rp_app_action_activate() {
  docker service scale rp460-rollback-traefik=0 >/dev/null || return 1
  for attempt in $(seq 1 40); do
    if ! curl --silent --fail --connect-timeout 1 --max-time 2 \
      https://rp-callback.test/api/health/live >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if curl --silent --fail --connect-timeout 1 --max-time 2 \
    https://rp-callback.test/api/health/live >/dev/null 2>&1; then return 1; fi
  if rp_app_action_probe "$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" \
    "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" \
    > "$root/rp460-probe-out.log" 2> "$root/rp460-probe-err.log"; then
    echo 'FAIL: persistent HTTPS outage was accepted' >&2
    return 1
  fi
  if ! grep -q 'timed out after 120s' "$root/rp460-probe-err.log"; then
    cat "$root/rp460-probe-err.log" >&2
    echo 'FAIL: no genuine 120s probe deadline' >&2
    return 1
  fi
  docker service scale rp460-rollback-traefik=1 >/dev/null || return 1
  echo 'PASS: installer action activation failed on real 120s HTTPS outage'
  return 1
}
rp_upgrade_quiesce_database_clients() {
  docker rm -f rp460-candidate-api >/dev/null 2>&1 || true
  rp_rollback_zitadel_stop
}
rp_app_action_checkpoint_detach() {
  rp_rollback_zitadel_start "$source_zitadel" "source after rollback" || return 1
  rp460_original_action_detach "$1" || return 1
  # If creation failed before the candidate target existed, the source
  # database has no candidate identifier and must still be rollback-safe.
  if [[ -z "${RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID:-}" ]]; then
    echo 'PASS: rollback after rejected target create left no candidate ID'
    return 0
  fi
  local code
  code="$(curl --silent --show-error --no-location \
    --config "$root/rp460-management.conf" \
    --header 'Host: localhost:18080' --output "$root/rp460-postrestore.json" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:18080/v2/actions/targets/$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID")" || return 1
  [[ "$code" == 404 ]] || { echo "Orphaned target after rollback: HTTP $code" >&2; return 1; }
  echo 'PASS: candidate-only ZITADEL target removed by physical DB restore'
}
