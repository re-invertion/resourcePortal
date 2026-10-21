#!/usr/bin/env bash
# Real Swarm end-to-end test of the node-local RP route agent. Unlike the
# Gate dataplane smoke, this does not inject an application route manually.
set -euo pipefail
IMAGE="${RP_GATE_E2E_IMAGE:-resourceportal-gate-e2e:current}"
RUN_ID="$$"
NET_UUID="$(printf '00000000-0000-4000-8000-%012x' "$RUN_ID")"
NETWORK="rp-network-${NET_UUID}"
TENANT_ID="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
APP_ID="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
APP_GROUP="aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee"
APP_SERVICE="rp_${APP_GROUP}_route_agent_smoke"
GATE_SERVICE="rp_route_gate_${RUN_ID}"
ROUTER_SERVICE="rp_route_agent_${RUN_ID}"
APP_CONTAINER=""
SOURCE_CIDR="10.200.249.0/24"
DESTINATION="10.77.249.2/32"

fail() {
  echo "FAIL: $*" >&2
  docker service logs --tail 65 "$ROUTER_SERVICE" >&2 || true
  docker service ps --no-trunc "$ROUTER_SERVICE" >&2 || true
  exit 1
}
cleanup() {
  docker service rm "$ROUTER_SERVICE" "$APP_SERVICE" "$GATE_SERVICE" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker network rm "$NETWORK" >/dev/null 2>&1 && break
    sleep 1
  done
}
trap cleanup EXIT
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == active ]] || fail "Swarm required"
docker network create --driver overlay --attachable --subnet "$SOURCE_CIDR" "$NETWORK" >/dev/null

docker service create -q --name "$GATE_SERVICE" --network "$NETWORK" \
  --entrypoint sh "$IMAGE" -c 'sleep 600' >/dev/null
docker service create -q --name "$APP_SERVICE" --network "$NETWORK" \
  --container-label resourceportal.workload=tenant \
  --container-label "resourceportal.tenant-id=$TENANT_ID" \
  --container-label "resourceportal.single-app-id=$APP_ID" \
  --entrypoint sh "$IMAGE" -c 'sleep 600' >/dev/null

for _ in $(seq 1 45); do
  APP_CONTAINER="$(docker ps --filter "label=com.docker.swarm.service.name=$APP_SERVICE" --format '{{.ID}}' | head -1)"
  GATE_CONTAINER="$(docker ps --filter "label=com.docker.swarm.service.name=$GATE_SERVICE" --format '{{.ID}}' | head -1)"
  [[ -n "$APP_CONTAINER" && -n "$GATE_CONTAINER" ]] && break
  sleep 2
done
[[ -n "$APP_CONTAINER" && -n "$GATE_CONTAINER" ]] || fail "missing isolated Swarm tasks"
GATE_IP="$(docker inspect "$GATE_CONTAINER" --format "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}")"
[[ "$GATE_IP" == 10.200.249.* ]] || fail "missing Gate overlay address"
POLICY_JSON="$(jq -cn \
  --arg tenant "$TENANT_ID" --arg app "$APP_ID" --arg svc "$APP_SERVICE" \
  --arg network "$NETWORK" --arg source "$SOURCE_CIDR" \
  --arg destination "$DESTINATION" --arg gateway "$GATE_IP" \
  '{version:1,routes:[{tenantId:$tenant,singleAppId:$app,swarmServiceName:$svc,
   networkName:$network,sourceNetworkCidr:$source,destinationCidr:$destination,gatewayAddress:$gateway}]}')"
ENCODED="$(printf '%s' "$POLICY_JSON" | base64 -w0)"

docker service create -q --name "$ROUTER_SERVICE" --mode global \
  --network host --user 0 --cap-add NET_ADMIN --cap-add SYS_ADMIN \
  --mount type=bind,src=/proc,dst=/host/proc,readonly \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --env "RESOURCEPORTAL_APP_LAN_ROUTES_B64=$ENCODED" \
  --entrypoint node "$IMAGE" dist/src/networking/app-lan-route.runner.js >/dev/null

connected=false
for _ in $(seq 1 35); do
  ROUTE="$(docker exec "$APP_CONTAINER" ip -4 route get "${DESTINATION%%/*}" 2>/dev/null || true)"
  if [[ "$ROUTE" == *"via $GATE_IP"* ]]; then
    connected=true
    break
  fi
  sleep 2
done
[[ "$connected" == true ]] || fail "route agent did not inject the Site VPN route"
echo "PASS: unmodified tenant container received Site VPN route automatically"
docker service update --detach=false --env-rm RESOURCEPORTAL_APP_LAN_ROUTES_B64 "$ROUTER_SERVICE" >/dev/null

revoked=false
for _ in $(seq 1 35); do
  ROUTE="$(docker exec "$APP_CONTAINER" ip -4 route show proto 201 2>/dev/null || true)"
  if [[ "$ROUTE" != *"${DESTINATION%%/*}"* ]]; then
    revoked=true
    break
  fi
  sleep 2
done
[[ "$revoked" == true ]] || fail "revoked Site VPN route is still installed"
echo "PASS: revoking policy removed RP-owned route"
