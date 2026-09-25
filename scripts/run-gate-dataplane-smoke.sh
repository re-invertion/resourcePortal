#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/sbin:/sbin:$PATH"

IMAGE="${RP_GATE_E2E_IMAGE:-resourceportal-gate-e2e:current}"
PORT="${RP_GATE_E2E_PORT:-52999}"
OVERLAY_CIDR="${RP_GATE_E2E_OVERLAY_CIDR:-10.200.250.0/24}"
STABLE_CIDR="${RP_GATE_E2E_STABLE_CIDR:-10.240.250.0/24}"
STABLE_IP="${RP_GATE_E2E_STABLE_IP:-10.240.250.10}"
UNASSIGNED_IP="${RP_GATE_E2E_UNASSIGNED_IP:-10.240.250.11}"
LAN_CIDR="${RP_GATE_E2E_LAN_CIDR:-10.77.250.0/24}"
LAN_GATE_IP="${RP_GATE_E2E_LAN_GATE_IP:-10.77.250.1}"
LAN_CLIENT_IP="${RP_GATE_E2E_LAN_CLIENT_IP:-10.77.250.2}"
UNDERLAY_CIDR="${RP_GATE_E2E_UNDERLAY_CIDR:-172.31.250.0/30}"
UNDERLAY_HOST_IP="${RP_GATE_E2E_UNDERLAY_HOST_IP:-172.31.250.1}"
UNDERLAY_GATE_IP="${RP_GATE_E2E_UNDERLAY_GATE_IP:-172.31.250.2}"
SERVER_TUNNEL="${RP_GATE_E2E_SERVER_TUNNEL:-100.96.250.1/30}"
CLIENT_TUNNEL="${RP_GATE_E2E_CLIENT_TUNNEL:-100.96.250.2/30}"

RUN_ID="$$"
STACK="rp_gate_e2e_${RUN_ID}"
NETWORK="rp-gate-e2e-${RUN_ID}"
APP_SERVICE="rp_gate_e2e_app_${RUN_ID}"
SECRET="rp-gate-e2e-key-${RUN_ID}"
ATTACHMENT_ID="attachment-e2e-${RUN_ID}"
ALIAS="rp-att-${ATTACHMENT_ID}"
ROUTER_NS="rp-gate-router-${RUN_ID}"
CLIENT_NS="rp-gate-client-${RUN_ID}"
UH="rguh${RUN_ID}"
UR="rgur${RUN_ID}"
LR="rglr${RUN_ID}"
LC="rglc${RUN_ID}"
KEYDIR="/tmp/rp-gate-e2e-${RUN_ID}"
STACK_YAML="${KEYDIR}/gate.yml"
CLIENT_HTTP_LOG="${KEYDIR}/client-http.log"
NODE_ID="$(docker info --format '{{.Swarm.NodeID}}')"
OLD_CP_LABEL="$(docker node inspect "$NODE_ID" --format '{{index .Spec.Labels "rp.node.control-plane"}}')"

log() { printf '[gate-e2e] %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

wait_service() {
  local service="$1"
  local tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if docker service inspect "$service" >/dev/null 2>&1; then
      if docker service ps "$service" --filter desired-state=running --format '{{.CurrentState}}' | grep -q '^Running'; then
        return 0
      fi
    fi
    sleep 2
  done
  docker service ps --no-trunc "$service" || true
  docker service logs --tail 100 "$service" || true
  return 1
}

wait_http_success() {
  local ns="$1"
  local url="$2"
  local expected="$3"
  for _ in $(seq 1 30); do
    local out
    out="$(sudo -n ip netns exec "$ns" curl -fsS --connect-timeout 2 --max-time 4 "$url" 2>/dev/null || true)"
    if [ "$out" = "$expected" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  set +e
  if sudo -n ip netns list | grep -q "^$CLIENT_NS"; then
    sudo -n ip netns pids "$CLIENT_NS" | xargs -r sudo -n kill >/dev/null 2>&1 || true
  fi
  docker stack rm "$STACK" >/dev/null 2>&1 || true
  docker service rm "$APP_SERVICE" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker service inspect "${STACK}_gateway" >/dev/null 2>&1 || break
    sleep 1
  done
  docker secret rm "$SECRET" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  sudo -n ip netns del "$ROUTER_NS" >/dev/null 2>&1 || true
  sudo -n ip netns del "$CLIENT_NS" >/dev/null 2>&1 || true
  sudo -n ip link del "$UH" >/dev/null 2>&1 || true
  if [ -n "$OLD_CP_LABEL" ] && [ "$OLD_CP_LABEL" != "<no value>" ]; then
    docker node update --label-add "rp.node.control-plane=$OLD_CP_LABEL" "$NODE_ID" >/dev/null 2>&1 || true
  else
    docker node update --label-rm rp.node.control-plane "$NODE_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$KEYDIR"
}
trap cleanup EXIT

for cmd in docker ip wg iptables curl jq python3; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done
[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = "active" ] || fail "Docker Swarm is not active"
mkdir -p "$KEYDIR"
umask 077

wg genkey | tee "$KEYDIR/server.key" | wg pubkey > "$KEYDIR/server.pub"
wg genkey | tee "$KEYDIR/client.key" | wg pubkey > "$KEYDIR/client.pub"
SERVER_PUB="$(cat "$KEYDIR/server.pub")"
CLIENT_PUB="$(cat "$KEYDIR/client.pub")"

docker node update --label-add rp.node.control-plane=true "$NODE_ID" >/dev/null

docker network create   --driver overlay   --attachable   --opt encrypted   --subnet "$OVERLAY_CIDR"   "$NETWORK" >/dev/null

docker service create   --quiet   --name "$APP_SERVICE"   --replicas 1   --network "name=$NETWORK,alias=$ALIAS"   --entrypoint node   "$IMAGE"   -e 'require("http").createServer((_req,res)=>res.end("RP_GATE_E2E_OK")).listen(8080,"0.0.0.0")'   >/dev/null
wait_service "$APP_SERVICE" || fail "dummy app service failed"
pass "dummy application is running on encrypted Swarm overlay"

docker secret create "$SECRET" "$KEYDIR/server.key" >/dev/null

INPUT_JSON="$(jq -cn   --arg gateId "gate-e2e-$RUN_ID"   --arg image "$IMAGE"   --argjson publishedPort "$PORT"   --arg serverTunnelAddress "$SERVER_TUNNEL"   --arg clientTunnelAddress "$CLIENT_TUNNEL"   --arg peerPublicKey "$CLIENT_PUB"   --arg peerLanCidr "$LAN_CIDR"   --arg privateSecretName "$SECRET"   --arg networkId "network-e2e-$RUN_ID"   --arg swarmNetworkName "$NETWORK"   --arg overlayCidr "$OVERLAY_CIDR"   --arg attachmentId "$ATTACHMENT_ID"   --arg stableAddress "$STABLE_IP"   '{
    gateId:$gateId,
    image:$image,
    publishedPort:$publishedPort,
    serverTunnelAddress:$serverTunnelAddress,
    clientTunnelAddress:$clientTunnelAddress,
    peerPublicKey:$peerPublicKey,
    peerLanCidrs:[$peerLanCidr],
    privateSecretName:$privateSecretName,
    networks:[{
      id:$networkId,
      swarmNetworkName:$swarmNetworkName,
      overlayCidr:$overlayCidr,
      attachments:[{
        id:$attachmentId,
        address:$stableAddress
      }]
    }]
  }')"

INPUT_B64="$(printf '%s' "$INPUT_JSON" | base64 -w0)"
docker run --rm \
  -e "RP_GATE_INPUT_B64=$INPUT_B64" \
  "$IMAGE" \
  node -e '
    const {renderGateStack}=require("./dist/src/networking/gate-stack.js");
    const input=JSON.parse(Buffer.from(process.env.RP_GATE_INPUT_B64,"base64").toString("utf8"));
    process.stdout.write(renderGateStack(input));
  ' > "$STACK_YAML"

docker stack deploy --resolve-image never -c "$STACK_YAML" "$STACK" >/dev/null
GATE_SERVICE="${STACK}_gateway"
wait_service "$GATE_SERVICE" || fail "Gate service failed"
gate_ready=false
for _ in $(seq 1 30); do
  if docker service logs --tail 50 "$GATE_SERVICE" 2>&1 | grep -q 'listening UDP/51820'; then
    gate_ready=true
    break
  fi
  sleep 1
done
if [ "$gate_ready" != "true" ]; then
  docker service ps --no-trunc "$GATE_SERVICE" || true
  docker service logs --tail 100 "$GATE_SERVICE" || true
  fail "Gate runtime did not report WireGuard listener"
fi
pass "actual rendered Gate stack is running"

sudo -n ip netns add "$ROUTER_NS"
sudo -n ip netns add "$CLIENT_NS"
sudo -n ip link add "$UH" type veth peer name "$UR"
sudo -n ip link set "$UR" netns "$ROUTER_NS"
sudo -n ip addr add "${UNDERLAY_HOST_IP}/30" dev "$UH"
sudo -n ip link set "$UH" up
sudo -n ip netns exec "$ROUTER_NS" ip link set lo up
sudo -n ip netns exec "$ROUTER_NS" ip addr add "${UNDERLAY_GATE_IP}/30" dev "$UR"
sudo -n ip netns exec "$ROUTER_NS" ip link set "$UR" up

sudo -n ip link add "$LR" type veth peer name "$LC"
sudo -n ip link set "$LR" netns "$ROUTER_NS"
sudo -n ip link set "$LC" netns "$CLIENT_NS"
sudo -n ip netns exec "$ROUTER_NS" ip addr add "${LAN_GATE_IP}/24" dev "$LR"
sudo -n ip netns exec "$ROUTER_NS" ip link set "$LR" up
sudo -n ip netns exec "$CLIENT_NS" ip link set lo up
sudo -n ip netns exec "$CLIENT_NS" ip addr add "${LAN_CLIENT_IP}/24" dev "$LC"
sudo -n ip netns exec "$CLIENT_NS" ip link set "$LC" up
sudo -n ip netns exec "$CLIENT_NS" ip route add "$STABLE_CIDR" via "$LAN_GATE_IP"

client_tunnel_up() {
  sudo -n ip netns exec "$ROUTER_NS" ip link del rp-gate >/dev/null 2>&1 || true
  sudo -n ip netns exec "$ROUTER_NS" ip link add rp-gate type wireguard
  sudo -n ip netns exec "$ROUTER_NS" ip addr add "$CLIENT_TUNNEL" dev rp-gate
  sudo -n ip netns exec "$ROUTER_NS" wg set rp-gate \
    private-key "$KEYDIR/client.key" \
    peer "$SERVER_PUB" \
    endpoint "${UNDERLAY_HOST_IP}:$PORT" \
    allowed-ips "$STABLE_CIDR" \
    persistent-keepalive 5
  sudo -n ip netns exec "$ROUTER_NS" ip link set rp-gate up
  sudo -n ip netns exec "$ROUTER_NS" ip route replace "$STABLE_CIDR" dev rp-gate
}

client_tunnel_up
sudo -n ip netns exec "$ROUTER_NS" sysctl -q -w net.ipv4.ip_forward=1

sudo -n ip netns exec "$ROUTER_NS" iptables -N RP-GATE-LAN 2>/dev/null || true
sudo -n ip netns exec "$ROUTER_NS" iptables -F RP-GATE-LAN
sudo -n ip netns exec "$ROUTER_NS" iptables -C FORWARD -j RP-GATE-LAN 2>/dev/null   || sudo -n ip netns exec "$ROUTER_NS" iptables -I FORWARD 1 -j RP-GATE-LAN
sudo -n ip netns exec "$ROUTER_NS" iptables -A RP-GATE-LAN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
sudo -n ip netns exec "$ROUTER_NS" iptables -A RP-GATE-LAN -s "$LAN_CIDR" -d "$STABLE_CIDR" -o rp-gate -j ACCEPT
sudo -n ip netns exec "$ROUTER_NS" iptables -A RP-GATE-LAN -o rp-gate -j REJECT
sudo -n ip netns exec "$ROUTER_NS" iptables -A RP-GATE-LAN -i rp-gate -j REJECT
sudo -n ip netns exec "$ROUTER_NS" iptables -A RP-GATE-LAN -j RETURN

wait_http_success "$CLIENT_NS" "http://$STABLE_IP:8080/" "RP_GATE_E2E_OK"   || { sudo -n ip netns exec "$ROUTER_NS" wg show rp-gate || true; docker service logs --tail 100 "$GATE_SERVICE" || true; fail "LAN -> RP stable address failed"; }
pass "LAN client reaches assigned RP stable address through routed WireGuard Gate"

LATEST_HANDSHAKE="$(sudo -n ip netns exec "$ROUTER_NS" wg show rp-gate latest-handshakes | awk '{print $2}')"
[ "${LATEST_HANDSHAKE:-0}" -gt 0 ] || fail "WireGuard handshake was not established"
pass "WireGuard handshake established"

if sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 2 --max-time 4 "http://$UNASSIGNED_IP:8080/" >/dev/null 2>&1; then
  fail "unassigned stable address was reachable"
fi
pass "unassigned RP stable address is blocked"

sudo -n ip netns exec "$CLIENT_NS" python3 -m http.server 8090 --bind "$LAN_CLIENT_IP" >"$CLIENT_HTTP_LOG" 2>&1 &
sleep 1
APP_CONTAINER="$(docker ps --filter "label=com.docker.swarm.service.name=$APP_SERVICE" --format '{{.ID}}' | head -1)"
[ -n "$APP_CONTAINER" ] || fail "could not locate dummy app task container"
if docker exec "$APP_CONTAINER" node -e '
  const http=require("http");
  const req=http.get("http://10.77.250.2:8090/",()=>process.exit(0));
  req.on("error",()=>process.exit(2));
  req.setTimeout(2500,()=>{req.destroy();process.exit(3)});
' >/dev/null 2>&1; then
  fail "RP application unexpectedly reached LAN client"
fi
pass "RP application has no automatic route to LAN"

docker service update --force "$GATE_SERVICE" >/dev/null
wait_service "$GATE_SERVICE" || fail "Gate service failed after restart"
# Swarm ingress may keep the previous UDP flow pinned briefly after a task restart.
# The installed Gate agent performs this same tunnel rebuild when its handshake is stale.
client_tunnel_up
wait_http_success "$CLIENT_NS" "http://$STABLE_IP:8080/" "RP_GATE_E2E_OK"   || fail "Gate did not recover after service restart and tunnel rebuild"
pass "Gate recovers after runtime restart and client tunnel rebuild"

docker stack rm "$STACK" >/dev/null
for _ in $(seq 1 45); do
  service_gone=true
  task_gone=true
  docker service inspect "$GATE_SERVICE" >/dev/null 2>&1 && service_gone=false
  docker ps --filter "label=com.docker.swarm.service.name=$GATE_SERVICE" --format '{{.ID}}' | grep -q . && task_gone=false
  if [ "$service_gone" = "true" ] && [ "$task_gone" = "true" ]; then
    break
  fi
  sleep 1
done
closed=false
for _ in $(seq 1 20); do
  if ! sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 1 --max-time 2 "http://$STABLE_IP:8080/" >/dev/null 2>&1; then
    closed=true
    break
  fi
  sleep 1
done
[ "$closed" = "true" ] || fail "LAN access remained after Gate runtime removal"
pass "Gate removal/revoke path closes LAN access"

echo "All ResourcePortalGate real dataplane smoke checks passed."
