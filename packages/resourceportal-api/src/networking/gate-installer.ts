import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Install a dedicated LAN Attachments agent; routed Site VPN is unsupported. */
export function resourcePortalGateInstallerScript() {
  const lanAgent = readFileSync(join(__dirname, "gate-lan-agent.py"), "utf8");
  const managedUplink = readFileSync(join(__dirname, "gate-managed-uplink.py"), "utf8");
  return String.raw`#!/usr/bin/env bash
set -euo pipefail
API_URL=""
TOKEN=""
INTERVAL=30
AGENT_VERSION="gate-l2-v2"
STATE_DIR="/etc/resourceportal-gate"
STATE_FILE="$STATE_DIR/state.json"
PRIVATE_KEY="$STATE_DIR/private.key"
AGENT_BIN="/usr/local/sbin/resourceportal-gate-agent"
SERVICE_FILE="/etc/systemd/system/resourceportal-gate.service"
log() { printf '[RP Gate LAN] %s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) API_URL="__RP_SHELL_EXPAND__2:-}"; shift 2 ;;
    --token) TOKEN="__RP_SHELL_EXPAND__2:-}"; shift 2 ;;
    --interval) INTERVAL="__RP_SHELL_EXPAND__2:-30}"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "Run as root"
[ -n "$API_URL" ] && [ -n "$TOKEN" ] || die "--url and --token required"
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 120 ] ||
  die "Invalid heartbeat interval"
API_URL="__RP_SHELL_EXPAND__API_URL%/}"
install_packages() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl jq wireguard-tools iproute2 nftables python3 ca-certificates
  elif command -v dnf >/dev/null; then
    dnf install -y curl jq wireguard-tools iproute nftables python3 ca-certificates
  elif command -v yum >/dev/null; then
    yum install -y curl jq wireguard-tools iproute nftables python3 ca-certificates
  elif command -v apk >/dev/null; then
    apk add --no-cache curl jq wireguard-tools iproute2 nftables python3 ca-certificates
  else
    die "Unsupported distribution: install curl, jq, wg, ip, nft, python3"
  fi
}
install_packages
command -v systemctl >/dev/null || die "systemd is required"
install -d -m 0700 "$STATE_DIR"
install -d -m 0700 /etc/wireguard
if [ ! -s "$PRIVATE_KEY" ]; then umask 077; wg genkey > "$PRIVATE_KEY"; fi
chmod 0600 "$PRIVATE_KEY"
PUBLIC_KEY="$(wg pubkey < "$PRIVATE_KEY")"
PAYLOAD="$(jq -cn --arg token "$TOKEN" --arg key "$PUBLIC_KEY" \
  '{token:$token,publicKey:$key,agentVersion:"gate-l2-v2"}')"
RESPONSE="$(curl -fsS --max-time 20 -H 'content-type: application/json' -X POST \
  --data "$PAYLOAD" "$API_URL/networking/gates/enroll")" || die "LAN enrollment failed"
AGENT_TOKEN="$(printf '%s' "$RESPONSE" | jq -er .agentToken)"
GATE_ID="$(printf '%s' "$RESPONSE" | jq -er .gateId)"
umask 077
jq -cn --arg api "$API_URL" --arg token "$AGENT_TOKEN" \
  --arg gate "$GATE_ID" --argjson interval "$INTERVAL" \
  '{apiUrl:$api,agentToken:$token,gateId:$gate,interval:$interval}' > "$STATE_FILE"
chmod 0600 "$STATE_FILE"

cat > /usr/local/sbin/resourceportal-gate-lan.py <<'RP_GATE_LAN_PYTHON'
__RP_GATE_LAN_PYTHON__
RP_GATE_LAN_PYTHON
chmod 0700 /usr/local/sbin/resourceportal-gate-lan.py

# Install an explicit, standalone host-network command. Agent heartbeats never
# trigger NIC migration; the admin must run preflight/apply/confirm separately.
cat > /usr/local/sbin/resourceportal-gate-uplink <<'RP_GATE_UPLINK_PYTHON'
__RP_GATE_UPLINK_PYTHON__
RP_GATE_UPLINK_PYTHON
chmod 0700 /usr/local/sbin/resourceportal-gate-uplink

cat > "$AGENT_BIN" <<'RP_GATE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="/etc/resourceportal-gate/state.json"
PRIVATE_KEY="/etc/resourceportal-gate/private.key"
WG_CONF="/etc/wireguard/rp-gate.conf"
WG_INTERFACE="rp-gate"
LAN_AGENT="/usr/local/sbin/resourceportal-gate-lan.py"
log() { printf '[RP Gate LAN] %s\n' "$*"; }
revoke_lan() {
  python3 "$LAN_AGENT" --revoke-all || { log "LAN revocation failed; state retained"; return 1; }
}
down_tunnel() { wg-quick down "$WG_INTERFACE" >/dev/null 2>&1 || true; }
shutdown() { revoke_lan || true; down_tunnel; }
trap shutdown EXIT
trap 'exit 0' SIGTERM SIGINT

# Remove ONLY RP-owned legacy routing resources. Never reset the host's
# forwarding state or touch an unrelated FRR configuration.
retire_legacy() {
  if command -v iptables >/dev/null 2>&1; then
    iptables -D FORWARD -j RP-GATE-LAN >/dev/null 2>&1 || true
    iptables -F RP-GATE-LAN >/dev/null 2>&1 || true
    iptables -X RP-GATE-LAN >/dev/null 2>&1 || true
    iptables -t nat -D POSTROUTING -j RP-GATE-LAN-SNAT >/dev/null 2>&1 || true
    iptables -t nat -F RP-GATE-LAN-SNAT >/dev/null 2>&1 || true
    iptables -t nat -X RP-GATE-LAN-SNAT >/dev/null 2>&1 || true
  fi
  if [ -f /etc/sysctl.d/99-resourceportal-gate.conf ] &&
     grep -Fxq 'net.ipv4.ip_forward=1' /etc/sysctl.d/99-resourceportal-gate.conf; then
    rm -f /etc/sysctl.d/99-resourceportal-gate.conf
  fi
  systemctl disable --now resourceportal-gate-discovery.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/resourceportal-gate-discovery.service
  rm -f /usr/local/sbin/resourceportal-gate-discovery.py
  # The old exporter marked its own FRR block. Remove only that block,
  # then reload FRR so stale route advertisements stop on upgrade.
  if [ -f /etc/frr/frr.conf ] && grep -Fxq '! BEGIN RESOURCEPORTAL-GATE' /etc/frr/frr.conf; then
    local next
    next="$(mktemp /etc/frr/.rp-lan-frr-XXXXXX)"
    awk '
      $0 == "! BEGIN RESOURCEPORTAL-GATE" { managed=1; next }
      $0 == "! END RESOURCEPORTAL-GATE" { managed=0; next }
      !managed { print }
    ' /etc/frr/frr.conf > "$next"
    chmod --reference=/etc/frr/frr.conf "$next"
    chown --reference=/etc/frr/frr.conf "$next"
    mv "$next" /etc/frr/frr.conf
    if command -v vtysh >/dev/null 2>&1; then
      vtysh -b >/dev/null 2>&1 || log "FRR reload failed; check for stale RP-owned advertisements"
    fi
  fi
}
retire_legacy

CONFIG="$(cat "$STATE_FILE")"
API_URL="$(printf '%s' "$CONFIG" | jq -er .apiUrl)"
AGENT_TOKEN="$(printf '%s' "$CONFIG" | jq -er .agentToken)"
GATE_ID="$(printf '%s' "$CONFIG" | jq -er .gateId)"
INTERVAL="$(printf '%s' "$CONFIG" | jq -er .interval)"

apply_config() {
  local config="$1" count endpoint key addr server allowed tmp
  printf '%s' "$config" | jq -e --arg gate "$GATE_ID" \
    '.gateId==$gate and .lanAttachmentProtocol==1 and .revoked!=true and
     (.lanAttachments|type)=="array" and (.lanAttachments|length)<=64' >/dev/null || return 1
  count="$(printf '%s' "$config" | jq -r '.lanAttachments|length')"
  if [ "$count" -eq 0 ]; then revoke_lan; down_tunnel; return; fi
  endpoint="$(printf '%s' "$config" | jq -er .endpoint)"
  key="$(printf '%s' "$config" | jq -er .serverPublicKey)"
  addr="$(printf '%s' "$config" | jq -er .tunnelAddress)"
  server="$(printf '%s' "$config" | jq -er .serverTunnelAddress)"
  allowed="$(printf '%s' "$config" | jq -er '.allowedIps|join(",")')"
  [ "$allowed" = "__RP_SHELL_EXPAND__server%/*}/32" ] || return 1
  tmp="$(mktemp /etc/wireguard/.rp-gate-XXXXXX)"
  chmod 0600 "$tmp"
  cat > "$tmp" <<EOF
[Interface]
PrivateKey = $(cat "$PRIVATE_KEY")
Address = $addr
[Peer]
PublicKey = $key
Endpoint = $endpoint
AllowedIPs = $allowed
PersistentKeepalive = 25
EOF
  if [ ! -f "$WG_CONF" ] || ! cmp -s "$tmp" "$WG_CONF"; then
    revoke_lan || { rm -f "$tmp"; return 1; }
    down_tunnel
    mv "$tmp" "$WG_CONF"
    wg-quick up "$WG_INTERFACE" || return 1
  else
    rm -f "$tmp"
    wg show "$WG_INTERFACE" >/dev/null 2>&1 || wg-quick up "$WG_INTERFACE" || return 1
  fi
  printf '%s' "$config" | python3 "$LAN_AGENT" || { revoke_lan; return 1; }
}
while :; do
  # Report only locally observed, verified host bridge state. A missing or
  # stale proof is null; never fabricate a subnet from tenant policy.
  # Recheck actual host networking and authenticated RP access each cycle.
  # Expired local attestation is never reused.
  /usr/local/sbin/resourceportal-gate-uplink refresh >/dev/null 2>&1 || true
  OBSERVED_LAN="$(python3 "$LAN_AGENT" --observed-lan 2>/dev/null || printf 'null')"
  HEARTBEAT="$(jq -cn --argjson observation "$OBSERVED_LAN" \
    '{agentVersion:"gate-l2-v2",lanObservation:$observation}')" || HEARTBEAT='{"agentVersion":"gate-l2-v2"}'
  if RESPONSE="$(curl -fsS --max-time 20 -H "authorization: Bearer $AGENT_TOKEN" \
    -H 'content-type: application/json' -X POST \
    --data "$HEARTBEAT" \
    "$API_URL/networking/gates/agent/heartbeat")"; then
    if ! apply_config "$RESPONSE"; then
      revoke_lan || true
      down_tunnel
      log "LAN policy invalid or tunnel unavailable"
    fi
  else
    revoke_lan || true
    down_tunnel
    log "Heartbeat failure; bridge revoked"
  fi
  sleep "$INTERVAL" &
  wait $! || exit 0
done
RP_GATE_AGENT
chmod 0700 "$AGENT_BIN"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ResourcePortal LAN Attachment Gate
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=$AGENT_BIN
Restart=always
RestartSec=5
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable resourceportal-gate.service
systemctl restart resourceportal-gate.service
log "LAN Gate enrolled as $GATE_ID"
`.replace("__RP_GATE_LAN_PYTHON__", lanAgent).replace("__RP_GATE_UPLINK_PYTHON__", managedUplink).replaceAll("__RP_SHELL_EXPAND__", "${");
}
