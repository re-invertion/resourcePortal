export function resourcePortalGateInstallerScript() {
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

API_URL=""
ENROLLMENT_TOKEN=""
INTERVAL="30"
AGENT_VERSION="gate-shell-v1"
STATE_DIR="/etc/resourceportal-gate"
STATE_FILE="$STATE_DIR/state.json"
PRIVATE_KEY="$STATE_DIR/private.key"
AGENT_BIN="/usr/local/sbin/resourceportal-gate-agent"
WG_CONF="/etc/wireguard/rp-gate.conf"
SERVICE_FILE="/etc/systemd/system/resourceportal-gate.service"

log() { printf '[ResourcePortalGate] %s\n' "$*"; }
die() { printf '[ResourcePortalGate] ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url) API_URL="__RP_SHELL_EXPAND__2:-}"; shift 2 ;;
    --token) ENROLLMENT_TOKEN="__RP_SHELL_EXPAND__2:-}"; shift 2 ;;
    --interval) INTERVAL="__RP_SHELL_EXPAND__2:-30}"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run the installer as root (for example through sudo bash)."
[ -n "$API_URL" ] || die "--url is required"
[ -n "$ENROLLMENT_TOKEN" ] || die "--token is required"
command -v systemctl >/dev/null 2>&1 || die "systemd is required for ResourcePortalGate v1"

API_URL="__RP_SHELL_EXPAND__API_URL%/}"

install_dependencies() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl jq wireguard-tools iproute2 iptables ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl jq wireguard-tools iproute iptables ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl jq wireguard-tools iproute iptables ca-certificates
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl jq wireguard-tools iproute2 iptables ca-certificates
  else
    die "Unsupported package manager. Install curl, jq, wireguard-tools, iproute2 and iptables manually."
  fi
}

discover_lan_addresses() {
  ip -o -4 addr show scope global \
    | awk '{print $4}' \
    | cut -d/ -f1 \
    | sort -u \
    | jq -R . \
    | jq -s .
}

discover_lan_cidrs() {
  ip -o -4 route show scope link \
    | awk '{print $1}' \
    | grep -E '^[0-9]+(\.[0-9]+){3}/[0-9]+$' \
    | sort -u \
    | jq -R . \
    | jq -s .
}

log "Installing dependencies"
install_dependencies
install -d -m 0700 "$STATE_DIR"
install -d -m 0700 /etc/wireguard

if [ ! -s "$PRIVATE_KEY" ]; then
  umask 077
  wg genkey > "$PRIVATE_KEY"
fi
chmod 0600 "$PRIVATE_KEY"
PUBLIC_KEY="$(wg pubkey < "$PRIVATE_KEY")"
LAN_ADDRESSES="$(discover_lan_addresses)"
LAN_CIDRS="$(discover_lan_cidrs)"

PAYLOAD="$(jq -cn \
  --arg token "$ENROLLMENT_TOKEN" \
  --arg publicKey "$PUBLIC_KEY" \
  --arg agentVersion "$AGENT_VERSION" \
  --argjson lanAddresses "$LAN_ADDRESSES" \
  --argjson lanCidrs "$LAN_CIDRS" \
  '{token:$token,publicKey:$publicKey,lanAddresses:$lanAddresses,lanCidrs:$lanCidrs,agentVersion:$agentVersion}')"

log "Enrolling with ResourcePortal"
ENROLL_RESPONSE="$(curl -fsS \
  -H 'content-type: application/json' \
  -X POST \
  --data "$PAYLOAD" \
  "$API_URL/networking/gates/enroll")"

AGENT_TOKEN="$(printf '%s' "$ENROLL_RESPONSE" | jq -er '.agentToken')"
GATE_ID="$(printf '%s' "$ENROLL_RESPONSE" | jq -er '.gateId')"

umask 077
jq -cn \
  --arg apiUrl "$API_URL" \
  --arg agentToken "$AGENT_TOKEN" \
  --arg gateId "$GATE_ID" \
  --arg interval "$INTERVAL" \
  '{apiUrl:$apiUrl,agentToken:$agentToken,gateId:$gateId,interval:($interval|tonumber)}' \
  > "$STATE_FILE"
chmod 0600 "$STATE_FILE"

cat > "$AGENT_BIN" <<'RP_GATE_AGENT'
#!/usr/bin/env bash
set -u

STATE_FILE="/etc/resourceportal-gate/state.json"
PRIVATE_KEY="/etc/resourceportal-gate/private.key"
WG_CONF="/etc/wireguard/rp-gate.conf"
WG_INTERFACE="rp-gate"
FIREWALL_CHAIN="RP-GATE-LAN"
TUNNEL_UP_FILE="/run/resourceportal-gate-last-up"
HANDSHAKE_STALE_SECONDS="90"
AGENT_VERSION="gate-shell-v1"

log() { printf '[ResourcePortalGate] %s\n' "$*"; }

discover_lan_addresses() {
  ip -o -4 addr show scope global \
    | awk '{print $4}' \
    | cut -d/ -f1 \
    | sort -u \
    | jq -R . \
    | jq -s .
}

discover_lan_cidrs() {
  ip -o -4 route show scope link \
    | awk '{print $1}' \
    | grep -E '^[0-9]+(\.[0-9]+){3}/[0-9]+$' \
    | sort -u \
    | jq -R . \
    | jq -s .
}

down_tunnel() {
  wg-quick down "$WG_INTERFACE" >/dev/null 2>&1 || true
  rm -f "$TUNNEL_UP_FILE"
}

up_tunnel() {
  wg-quick up "$WG_INTERFACE"
  date +%s > "$TUNNEL_UP_FILE"
}

ensure_tunnel_health() {
  local now latest reference age
  if ! wg show "$WG_INTERFACE" >/dev/null 2>&1; then
    up_tunnel
    return
  fi

  now="$(date +%s)"
  latest="$(wg show "$WG_INTERFACE" latest-handshakes | awk 'NR == 1 {print $2}')"
  if [ -n "$latest" ] && [ "$latest" -gt 0 ] 2>/dev/null; then
    reference="$latest"
  else
    reference="$(cat "$TUNNEL_UP_FILE" 2>/dev/null || printf '%s' "$now")"
  fi
  age=$((now - reference))
  if [ "$age" -ge "$HANDSHAKE_STALE_SECONDS" ]; then
    log "WireGuard handshake stale for __RP_SHELL_EXPAND__age}s; rebuilding tunnel"
    down_tunnel
    up_tunnel
  fi
}

sync_firewall() {
  local lan_cidrs="$1"
  local allowed_ips="$2"

  iptables -N "$FIREWALL_CHAIN" 2>/dev/null || true
  iptables -F "$FIREWALL_CHAIN"
  iptables -C FORWARD -j "$FIREWALL_CHAIN" 2>/dev/null \
    || iptables -I FORWARD 1 -j "$FIREWALL_CHAIN"

  iptables -A "$FIREWALL_CHAIN" \
    -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  while IFS= read -r lan; do
    [ -n "$lan" ] || continue
    while IFS= read -r target; do
      [ -n "$target" ] || continue
      iptables -A "$FIREWALL_CHAIN" \
        -s "$lan" -d "$target" -o "$WG_INTERFACE" -j ACCEPT
    done < <(printf '%s' "$allowed_ips" | jq -r '.[]')
  done < <(printf '%s' "$lan_cidrs" | jq -r '.[]')

  iptables -A "$FIREWALL_CHAIN" -o "$WG_INTERFACE" -j REJECT
  iptables -A "$FIREWALL_CHAIN" -i "$WG_INTERFACE" -j REJECT
  iptables -A "$FIREWALL_CHAIN" -j RETURN
}

write_wireguard_config() {
  local config="$1"
  local allowed
  allowed="$(printf '%s' "$config" | jq -r '.allowedIps | join(",")')"
  local endpoint
  endpoint="$(printf '%s' "$config" | jq -r '.endpoint')"
  local server_key
  server_key="$(printf '%s' "$config" | jq -r '.serverPublicKey')"
  local tunnel
  tunnel="$(printf '%s' "$config" | jq -r '.tunnelAddress')"
  local keepalive
  keepalive="$(printf '%s' "$config" | jq -r '.persistentKeepaliveSeconds // 25')"
  local private_key
  private_key="$(cat "$PRIVATE_KEY")"

  cat > "$WG_CONF.tmp" <<EOF
[Interface]
PrivateKey = $private_key
Address = $tunnel

[Peer]
PublicKey = $server_key
Endpoint = $endpoint
AllowedIPs = $allowed
PersistentKeepalive = $keepalive
EOF
  chmod 0600 "$WG_CONF.tmp"

  if [ ! -f "$WG_CONF" ] || ! cmp -s "$WG_CONF.tmp" "$WG_CONF"; then
    down_tunnel
    mv "$WG_CONF.tmp" "$WG_CONF"
    up_tunnel
    log "Applied Gate configuration revision $(printf '%s' "$config" | jq -r '.configRevision')"
  else
    rm -f "$WG_CONF.tmp"
    ensure_tunnel_health
  fi
}

while true; do
  API_URL="$(jq -r '.apiUrl' "$STATE_FILE")"
  AGENT_TOKEN="$(jq -r '.agentToken' "$STATE_FILE")"
  INTERVAL="$(jq -r '.interval // 30' "$STATE_FILE")"
  LAN_ADDRESSES="$(discover_lan_addresses)"
  LAN_CIDRS="$(discover_lan_cidrs)"

  PAYLOAD="$(jq -cn \
    --arg agentVersion "$AGENT_VERSION" \
    --argjson lanAddresses "$LAN_ADDRESSES" \
    --argjson lanCidrs "$LAN_CIDRS" \
    '{lanAddresses:$lanAddresses,lanCidrs:$lanCidrs,agentVersion:$agentVersion}')"

  RESPONSE_FILE="$(mktemp)"
  HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -w '%{http_code}' \
    -H "authorization: Bearer $AGENT_TOKEN" \
    -H 'content-type: application/json' \
    -X POST \
    --data "$PAYLOAD" \
    "$API_URL/networking/gates/agent/heartbeat" || printf '000')"

  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    log "Gate token was revoked or rejected; tunnel disabled"
    down_tunnel
    rm -f "$RESPONSE_FILE"
    sleep "$INTERVAL"
    continue
  fi

  if [[ ! "$HTTP_CODE" =~ ^2 ]]; then
    log "Heartbeat failed with HTTP $HTTP_CODE"
    rm -f "$RESPONSE_FILE"
    sleep "$INTERVAL"
    continue
  fi

  CONFIG="$(cat "$RESPONSE_FILE")"
  rm -f "$RESPONSE_FILE"
  ALLOWED_IPS="$(printf '%s' "$CONFIG" | jq -c '.allowedIps // []')"

  if [ "$(printf '%s' "$ALLOWED_IPS" | jq 'length')" -eq 0 ]; then
    down_tunnel
  else
    write_wireguard_config "$CONFIG"
    sync_firewall "$LAN_CIDRS" "$ALLOWED_IPS"
  fi

  sleep "$INTERVAL"
done
RP_GATE_AGENT

chmod 0755 "$AGENT_BIN"

cat > /etc/sysctl.d/99-resourceportal-gate.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
sysctl --system >/dev/null

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=ResourcePortalGate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$AGENT_BIN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now resourceportal-gate.service

log "ResourcePortalGate enrolled as $GATE_ID"
log "The Gate will automatically receive RP Network routes."
log "If this host is not the LAN default gateway, add static routes on your LAN router for RP Network CIDRs via this Gate host."
`.replaceAll("__RP_SHELL_EXPAND__", "${");
}
