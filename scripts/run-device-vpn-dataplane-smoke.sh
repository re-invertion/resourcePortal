#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/sbin:/sbin:$PATH"

IMAGE="${RP_DEVICE_VPN_E2E_IMAGE:-resourceportal-device-vpn-e2e:current}"
PORT="${RP_DEVICE_VPN_E2E_PORT:-51999}"
OVERLAY_A="${RP_DEVICE_VPN_E2E_OVERLAY_A:-10.200.250.0/24}"
OVERLAY_B="${RP_DEVICE_VPN_E2E_OVERLAY_B:-10.200.251.0/24}"
STABLE_A_CIDR="${RP_DEVICE_VPN_E2E_STABLE_A_CIDR:-10.240.250.0/24}"
STABLE_B_CIDR="${RP_DEVICE_VPN_E2E_STABLE_B_CIDR:-10.240.251.0/24}"
STABLE_A="${RP_DEVICE_VPN_E2E_STABLE_A:-10.240.250.10}"
STABLE_B="${RP_DEVICE_VPN_E2E_STABLE_B:-10.240.251.10}"
UNDERLAY_CIDR="${RP_DEVICE_VPN_E2E_UNDERLAY_CIDR:-172.31.251.0/30}"
UNDERLAY_HOST_IP="${RP_DEVICE_VPN_E2E_UNDERLAY_HOST_IP:-172.31.251.1}"
UNDERLAY_CLIENT_IP="${RP_DEVICE_VPN_E2E_UNDERLAY_CLIENT_IP:-172.31.251.2}"
SERVER_TUNNEL="${RP_DEVICE_VPN_E2E_SERVER_TUNNEL:-100.64.250.1/24}"
CLIENT_A="${RP_DEVICE_VPN_E2E_CLIENT_A:-100.64.250.2}"
CLIENT_B="${RP_DEVICE_VPN_E2E_CLIENT_B:-100.64.250.3}"

RUN_ID="$$"
STACK="rp_device_vpn_e2e_${RUN_ID}"
NETWORK_A="rp-device-vpn-e2e-a-${RUN_ID}"
NETWORK_B="rp-device-vpn-e2e-b-${RUN_ID}"
APP_A="rp_device_vpn_e2e_app_a_${RUN_ID}"
APP_B="rp_device_vpn_e2e_app_b_${RUN_ID}"
PRIVATE_SECRET="rp-device-vpn-e2e-key-${RUN_ID}"
TOKEN_SECRET="rp-device-vpn-e2e-token-${RUN_ID}"
ATTACHMENT_A="dvpn-att-a-${RUN_ID}"
ATTACHMENT_B="dvpn-att-b-${RUN_ID}"
ALIAS_A="rp-att-${ATTACHMENT_A}"
ALIAS_B="rp-att-${ATTACHMENT_B}"
CLIENT_NS="rp-dvpn-client-${RUN_ID}"
VH="dvuh${RUN_ID}"
VC="dvuc${RUN_ID}"
KEYDIR="/tmp/rp-device-vpn-e2e-${RUN_ID}"
STACK_YAML="${KEYDIR}/device-vpn.yml"
NODE_ID="$(docker info --format '{{.Swarm.NodeID}}')"
OLD_CP_LABEL="$(docker node inspect "$NODE_ID" --format '{{index .Spec.Labels "rp.node.control-plane"}}')"

log() { printf '[device-vpn-e2e] %s\n' "$*"; }
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
  local url="$1"
  local expected="$2"
  for _ in $(seq 1 30); do
    local out
    out="$(sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 2 --max-time 4 "$url" 2>/dev/null || true)"
    if [ "$out" = "$expected" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cleanup() {
  set +e
  docker stack rm "$STACK" >/dev/null 2>&1 || true
  docker service rm "$APP_A" "$APP_B" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    docker service inspect "${STACK}_gateway" >/dev/null 2>&1 || break
    sleep 1
  done
  docker secret rm "$PRIVATE_SECRET" "$TOKEN_SECRET" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_A" "$NETWORK_B" >/dev/null 2>&1 || true
  sudo -n ip netns del "$CLIENT_NS" >/dev/null 2>&1 || true
  sudo -n ip link del "$VH" >/dev/null 2>&1 || true
  if [ -n "$OLD_CP_LABEL" ] && [ "$OLD_CP_LABEL" != "<no value>" ]; then
    docker node update --label-add "rp.node.control-plane=$OLD_CP_LABEL" "$NODE_ID" >/dev/null 2>&1 || true
  else
    docker node update --label-rm rp.node.control-plane "$NODE_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$KEYDIR"
}
trap cleanup EXIT

for cmd in docker ip wg iptables curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || fail "missing command: $cmd"
done
[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = "active" ] || fail "Docker Swarm is not active"
sudo -n true >/dev/null 2>&1 || fail "passwordless sudo is required for network namespace smoke"

mkdir -p "$KEYDIR"
umask 077
wg genkey | tee "$KEYDIR/server.key" | wg pubkey > "$KEYDIR/server.pub"
wg genkey | tee "$KEYDIR/client-a.key" | wg pubkey > "$KEYDIR/client-a.pub"
wg genkey | tee "$KEYDIR/client-b.key" | wg pubkey > "$KEYDIR/client-b.pub"
SERVER_PUB="$(cat "$KEYDIR/server.pub")"
CLIENT_A_PUB="$(cat "$KEYDIR/client-a.pub")"
CLIENT_B_PUB="$(cat "$KEYDIR/client-b.pub")"
printf 'device-vpn-runtime-token-%s' "$RUN_ID" > "$KEYDIR/runtime.token"

docker node update --label-add rp.node.control-plane=true "$NODE_ID" >/dev/null

for spec in "$NETWORK_A:$OVERLAY_A" "$NETWORK_B:$OVERLAY_B"; do
  name="${spec%%:*}"
  subnet="${spec#*:}"
  docker network create --driver overlay --attachable --opt encrypted --subnet "$subnet" "$name" >/dev/null
done

docker service create --quiet --name "$APP_A" --replicas 1   --network "name=$NETWORK_A,alias=$ALIAS_A" --entrypoint node "$IMAGE"   -e 'require("http").createServer((_req,res)=>res.end("DEVICE_VPN_A_OK")).listen(8080,"0.0.0.0")' >/dev/null
docker service create --quiet --name "$APP_B" --replicas 1   --network "name=$NETWORK_B,alias=$ALIAS_B" --entrypoint node "$IMAGE"   -e 'require("http").createServer((_req,res)=>res.end("DEVICE_VPN_B_OK")).listen(8080,"0.0.0.0")' >/dev/null
wait_service "$APP_A" || fail "authorized dummy application failed"
wait_service "$APP_B" || fail "unauthorized dummy application failed"
pass "two applications are running on separate encrypted Swarm overlays"

docker secret create "$PRIVATE_SECRET" "$KEYDIR/server.key" >/dev/null
docker secret create "$TOKEN_SECRET" "$KEYDIR/runtime.token" >/dev/null

INPUT_JSON="$(jq -cn   --arg image "$IMAGE"   --argjson publishedPort "$PORT"   --arg serverTunnelAddress "$SERVER_TUNNEL"   --arg privateSecretName "$PRIVATE_SECRET"   --arg runtimeTokenSecretName "$TOKEN_SECRET"   --arg clientAPublicKey "$CLIENT_A_PUB"   --arg clientBPublicKey "$CLIENT_B_PUB"   --arg clientA "$CLIENT_A"   --arg clientB "$CLIENT_B"   --arg networkA "$NETWORK_A"   --arg networkB "$NETWORK_B"   --arg overlayA "$OVERLAY_A"   --arg overlayB "$OVERLAY_B"   --arg attachmentA "$ATTACHMENT_A"   --arg attachmentB "$ATTACHMENT_B"   --arg stableA "$STABLE_A"   --arg stableB "$STABLE_B"   '{
    gatewayId:"device-vpn-e2e",
    image:$image,
    publishedPort:$publishedPort,
    serverTunnelAddress:$serverTunnelAddress,
    privateSecretName:$privateSecretName,
    runtimeTokenSecretName:$runtimeTokenSecretName,
    heartbeatUrl:"http://127.0.0.1:9/api/networking/device-vpn/runtime/heartbeat",
    peers:[
      {
        deviceId:"client-a",
        publicKey:$clientAPublicKey,
        assignedAddress:$clientA,
        networkIds:["network-a"]
      },
      {
        deviceId:"client-b",
        publicKey:$clientBPublicKey,
        assignedAddress:$clientB,
        networkIds:["network-b"]
      }
    ],
    networks:[
      {
        id:"network-a",
        swarmNetworkName:$networkA,
        overlayCidr:$overlayA,
        attachments:[{id:$attachmentA,address:$stableA}]
      },
      {
        id:"network-b",
        swarmNetworkName:$networkB,
        overlayCidr:$overlayB,
        attachments:[{id:$attachmentB,address:$stableB}]
      }
    ]
  }')"

INPUT_B64="$(printf '%s' "$INPUT_JSON" | base64 -w0)"
docker run --rm   -e "RP_DEVICE_VPN_INPUT_B64=$INPUT_B64"   "$IMAGE"   node -e '
    const {renderDeviceVpnStack}=require("./dist/src/networking/device-vpn-stack.js");
    const input=JSON.parse(Buffer.from(process.env.RP_DEVICE_VPN_INPUT_B64,"base64").toString("utf8"));
    process.stdout.write(renderDeviceVpnStack(input));
  ' > "$STACK_YAML"

docker stack deploy --resolve-image never -c "$STACK_YAML" "$STACK" >/dev/null
GATE_SERVICE="${STACK}_gateway"
wait_service "$GATE_SERVICE" || fail "Device VPN gateway service failed"
ready=false
for _ in $(seq 1 30); do
  if docker service logs --tail 80 "$GATE_SERVICE" 2>&1 | grep -q 'listening UDP/51820'; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != "true" ]; then
  docker service ps --no-trunc "$GATE_SERVICE" || true
  docker service logs --tail 100 "$GATE_SERVICE" || true
  fail "Device VPN runtime did not report WireGuard listener"
fi
pass "shared Device VPN WireGuard concentrator is running"

sudo -n ip netns add "$CLIENT_NS"
sudo -n ip link add "$VH" type veth peer name "$VC"
sudo -n ip link set "$VC" netns "$CLIENT_NS"
sudo -n ip addr add "${UNDERLAY_HOST_IP}/30" dev "$VH"
sudo -n ip link set "$VH" up
sudo -n ip netns exec "$CLIENT_NS" ip link set lo up
sudo -n ip netns exec "$CLIENT_NS" ip addr add "${UNDERLAY_CLIENT_IP}/30" dev "$VC"
sudo -n ip netns exec "$CLIENT_NS" ip link set "$VC" up

sudo -n ip netns exec "$CLIENT_NS" ip link add rp-device-vpn type wireguard
sudo -n ip netns exec "$CLIENT_NS" ip addr add "${CLIENT_A}/32" dev rp-device-vpn
sudo -n ip netns exec "$CLIENT_NS" wg set rp-device-vpn   private-key "$KEYDIR/client-a.key"   peer "$SERVER_PUB"   endpoint "${UNDERLAY_HOST_IP}:$PORT"   allowed-ips "$STABLE_A_CIDR,$STABLE_B_CIDR"   persistent-keepalive 5
sudo -n ip netns exec "$CLIENT_NS" ip link set rp-device-vpn up
sudo -n ip netns exec "$CLIENT_NS" ip route replace "$STABLE_A_CIDR" dev rp-device-vpn
sudo -n ip netns exec "$CLIENT_NS" ip route replace "$STABLE_B_CIDR" dev rp-device-vpn

wait_http_success "http://$STABLE_A:8080/" "DEVICE_VPN_A_OK" || {
  sudo -n ip netns exec "$CLIENT_NS" wg show rp-device-vpn || true
  docker service logs --tail 120 "$GATE_SERVICE" || true
  fail "authorized Device VPN Network was not reachable"
}
pass "Device VPN peer reaches explicitly authorized RP Network"

LATEST_HANDSHAKE="$(sudo -n ip netns exec "$CLIENT_NS" wg show rp-device-vpn latest-handshakes | awk '{print $2}')"
[ "${LATEST_HANDSHAKE:-0}" -gt 0 ] || fail "Device VPN WireGuard handshake was not established"
pass "Device VPN WireGuard handshake established"

if sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 2 --max-time 4 "http://$STABLE_B:8080/" >/dev/null 2>&1; then
  fail "Device VPN peer reached a Network assigned only to another peer"
fi
pass "server-side source-/32 ACL blocks a non-authorized RP Network"

if sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 2 --max-time 4 "http://1.1.1.1/" >/dev/null 2>&1; then
  fail "Device VPN unexpectedly provided Internet forwarding"
fi
pass "Device VPN does not provide full-tunnel Internet forwarding"

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
  if ! sudo -n ip netns exec "$CLIENT_NS" curl -fsS --connect-timeout 1 --max-time 2 "http://$STABLE_A:8080/" >/dev/null 2>&1; then
    closed=true
    break
  fi
  sleep 1
done
[ "$closed" = "true" ] || fail "Device VPN access remained after concentrator removal"
pass "Device VPN revoke/removal path closes device access"

echo "All Device VPN real dataplane smoke checks passed."
