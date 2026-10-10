export function resourcePortalGateInstallerScript() {
  return String.raw`#!/usr/bin/env bash
set -euo pipefail

API_URL=""
ENROLLMENT_TOKEN=""
INTERVAL="30"
AGENT_VERSION="gate-shell-v3"
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
LAN_SNAT_CHAIN="RP-GATE-LAN-SNAT"
TUNNEL_UP_FILE="/run/resourceportal-gate-last-up"
HANDSHAKE_STALE_SECONDS="90"
AGENT_VERSION="gate-shell-v3"
FRR_CONFIG="/etc/frr/frr.conf"
FRR_DAEMONS="/etc/frr/daemons"
FRR_BEGIN="! BEGIN RESOURCEPORTAL-GATE"
FRR_END="! END RESOURCEPORTAL-GATE"

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
  local allow_lan_to_rp="$3"
  local allow_rp_to_lan="$4"
  local server_tunnel_source="$5"
  local rules_file

  iptables -N "$FIREWALL_CHAIN" 2>/dev/null || true
  iptables -t nat -N "$LAN_SNAT_CHAIN" 2>/dev/null || true
  rules_file="$(mktemp)"
  # A single iptables-restore COMMIT avoids transient fail-open during policy updates.
  {
    printf '*filter\n'
    printf -- '-F %s\n' "$FIREWALL_CHAIN"
    printf -- '-A %s -i %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$FIREWALL_CHAIN" "$WG_INTERFACE"
    printf -- '-A %s -o %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "$FIREWALL_CHAIN" "$WG_INTERFACE"

    if [ "$allow_lan_to_rp" = "true" ]; then
      while IFS= read -r lan; do
        [ -n "$lan" ] || continue
        while IFS= read -r target; do
          [ -n "$target" ] || continue
          printf -- '-A %s -s %s -d %s -o %s -m conntrack --ctstate NEW -j ACCEPT\n' \
            "$FIREWALL_CHAIN" "$lan" "$target" "$WG_INTERFACE"
        done < <(printf '%s' "$allowed_ips" | jq -r '.[]')
      done < <(printf '%s' "$lan_cidrs" | jq -r '.[]')
    fi

    if [ "$allow_rp_to_lan" = "true" ] && [ -n "$server_tunnel_source" ]; then
      while IFS= read -r lan; do
        [ -n "$lan" ] || continue
        printf -- '-A %s -i %s -s %s -d %s -m conntrack --ctstate NEW -j ACCEPT\n' \
          "$FIREWALL_CHAIN" "$WG_INTERFACE" "$server_tunnel_source" "$lan"
      done < <(printf '%s' "$lan_cidrs" | jq -r '.[]')
    fi
    printf -- '-A %s -o %s -j REJECT\n' "$FIREWALL_CHAIN" "$WG_INTERFACE"
    printf -- '-A %s -i %s -j REJECT\n' "$FIREWALL_CHAIN" "$WG_INTERFACE"
    printf -- '-A %s -j RETURN\n' "$FIREWALL_CHAIN"
    printf 'COMMIT\n'
    printf '*nat\n'
    printf -- '-F %s\n' "$LAN_SNAT_CHAIN"
    if [ "$allow_rp_to_lan" = "true" ] && [ -n "$server_tunnel_source" ]; then
      # Translate tunnel sources to this Gate host's LAN address so devices
      # can reply locally without a separate /32 route on the LAN router.
      while IFS= read -r lan; do
        [ -n "$lan" ] || continue
        printf -- '-A %s -s %s -d %s -j MASQUERADE\n' \
          "$LAN_SNAT_CHAIN" "$server_tunnel_source" "$lan"
      done < <(printf '%s' "$lan_cidrs" | jq -r '.[]')
    fi
    printf 'COMMIT\n'
  } > "$rules_file"
  if ! iptables-restore -w 5 --noflush < "$rules_file"; then
    log "Failed to apply Gate firewall policy; taking down tunnel (fail closed)"
    rm -f "$rules_file"
    down_tunnel
    return 1
  fi
  rm -f "$rules_file"
  if ! (iptables -C FORWARD -j "$FIREWALL_CHAIN" 2>/dev/null \
    || iptables -I FORWARD 1 -j "$FIREWALL_CHAIN"); then
    down_tunnel
    return 1
  fi
  if ! (iptables -t nat -C POSTROUTING -j "$LAN_SNAT_CHAIN" 2>/dev/null \
    || iptables -t nat -I POSTROUTING 1 -j "$LAN_SNAT_CHAIN"); then
    down_tunnel
    return 1
  fi
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

strip_managed_frr_config() {
  local input="$1"
  local output="$2"
  if [ ! -f "$input" ]; then
    : > "$output"
    return
  fi
  awk -v begin="$FRR_BEGIN" -v end="$FRR_END" '
    $0 == begin { managed=1; next }
    $0 == end { managed=0; next }
    !managed { print }
  ' "$input" > "$output"
}

has_unmanaged_bgp() {
  local stripped
  stripped="$(mktemp)"
  strip_managed_frr_config "$FRR_CONFIG" "$stripped"
  if grep -Eq '^[[:space:]]*router bgp[[:space:]]+[0-9]+' "$stripped"; then
    rm -f "$stripped"
    return 0
  fi
  rm -f "$stripped"
  return 1
}

ensure_frr_installed() {
  if command -v vtysh >/dev/null 2>&1; then
    return 0
  fi

  log "Installing FRR for BGP route advertisement"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y frr
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y frr
  elif command -v yum >/dev/null 2>&1; then
    yum install -y frr
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache frr
  else
    log "BGP reconcile failed: FRR is not installed and no supported package manager is available"
    return 1
  fi

  if ! command -v vtysh >/dev/null 2>&1; then
    log "BGP reconcile failed: FRR installation did not provide vtysh"
    return 1
  fi
}

prepare_frr_service() {
  ensure_frr_installed || return 1
  install -d -m 0755 /etc/frr
  if [ -f "$FRR_DAEMONS" ]; then
    local daemon
    for daemon in zebra bgpd; do
      if grep -q "^$daemon=" "$FRR_DAEMONS"; then
        sed -i "s/^$daemon=.*/$daemon=yes/" "$FRR_DAEMONS"
      else
        printf '\n%s=yes\n' "$daemon" >> "$FRR_DAEMONS"
      fi
    done
  fi
  systemctl enable --now frr.service >/dev/null 2>&1 \
    || systemctl enable --now frr >/dev/null 2>&1
}

install_frr_config() {
  local source="$1"
  chmod 0640 "$source"
  if id -u frr >/dev/null 2>&1; then
    chown frr:frr "$source" 2>/dev/null || true
  fi
  mv "$source" "$FRR_CONFIG"
  if ! systemctl restart frr.service >/dev/null 2>&1 \
    && ! systemctl restart frr >/dev/null 2>&1; then
    return 1
  fi
  vtysh -b >/dev/null 2>&1
}

disable_bgp() {
  local stripped
  stripped="$(mktemp)"
  strip_managed_frr_config "$FRR_CONFIG" "$stripped"
  if [ ! -f "$FRR_CONFIG" ]; then
    rm -f "$stripped"
    return
  fi
  if cmp -s "$stripped" "$FRR_CONFIG"; then
    rm -f "$stripped"
    return
  fi
  chmod 0640 "$stripped"
  if id -u frr >/dev/null 2>&1; then
    chown frr:frr "$stripped" 2>/dev/null || true
  fi
  mv "$stripped" "$FRR_CONFIG"
  systemctl restart frr.service >/dev/null 2>&1 \
    || systemctl restart frr >/dev/null 2>&1 \
    || true
  vtysh -b >/dev/null 2>&1 || true
  log "Disabled ResourcePortalGate BGP advertisements"
}

sync_bgp() {
  local config="$1"
  local lan_addresses="$2"
  local mode
  mode="$(printf '%s' "$config" | jq -r '.routeAdvertisement.mode // "Manual"')"

  if [ "$mode" != "BGP" ]; then
    disable_bgp
    return
  fi

  if has_unmanaged_bgp; then
    log "Refusing BGP reconcile because /etc/frr/frr.conf contains an unmanaged router bgp stanza"
    disable_bgp
    return
  fi

  local local_asn router_address router_asn source_address hold_time keepalive advertised
  local_asn="$(printf '%s' "$config" | jq -er '.routeAdvertisement.localAsn')"
  router_address="$(printf '%s' "$config" | jq -er '.routeAdvertisement.routerAddress')"
  router_asn="$(printf '%s' "$config" | jq -er '.routeAdvertisement.routerAsn')"
  source_address="$(printf '%s' "$config" | jq -r '.routeAdvertisement.sourceAddress // empty')"
  hold_time="$(printf '%s' "$config" | jq -r '.routeAdvertisement.holdTimeSeconds // 90')"
  advertised="$(printf '%s' "$config" | jq -c '.routeAdvertisement.advertisedCidrs // []')"

  if [ -z "$source_address" ]; then
    source_address="$(printf '%s' "$lan_addresses" | jq -r '.[0] // empty')"
  fi
  if [ -z "$source_address" ]; then
    log "BGP reconcile skipped: no LAN source/router-id address is available"
    disable_bgp
    return
  fi

  keepalive=$((hold_time / 3))
  if [ "$keepalive" -lt 1 ]; then keepalive=1; fi

  local stripped next seq cidr
  stripped="$(mktemp)"
  next="$(mktemp)"
  strip_managed_frr_config "$FRR_CONFIG" "$stripped"
  cat "$stripped" > "$next"
  rm -f "$stripped"
  printf '%s\n' "$FRR_BEGIN" >> "$next"

  seq=10
  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    printf 'ip prefix-list RP-GATE-EXPORT seq %s permit %s\n' "$seq" "$cidr" >> "$next"
    seq=$((seq + 10))
  done < <(printf '%s' "$advertised" | jq -r '.[]')
  printf 'ip prefix-list RP-GATE-EXPORT seq 65535 deny any\n' >> "$next"
  printf 'ip prefix-list RP-GATE-IMPORT seq 5 deny any\n' >> "$next"
  printf 'router bgp %s\n' "$local_asn" >> "$next"
  printf ' bgp router-id %s\n' "$source_address" >> "$next"
  printf ' neighbor %s remote-as %s\n' "$router_address" "$router_asn" >> "$next"
  printf ' neighbor %s timers %s %s\n' "$router_address" "$keepalive" "$hold_time" >> "$next"
  printf ' neighbor %s update-source %s\n' "$router_address" "$source_address" >> "$next"
  printf ' address-family ipv4 unicast\n' >> "$next"
  printf '  neighbor %s activate\n' "$router_address" >> "$next"
  printf '  neighbor %s prefix-list RP-GATE-IMPORT in\n' "$router_address" >> "$next"
  printf '  neighbor %s prefix-list RP-GATE-EXPORT out\n' "$router_address" >> "$next"
  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    printf '  network %s\n' "$cidr" >> "$next"
  done < <(printf '%s' "$advertised" | jq -r '.[]')
  printf ' exit-address-family\n' >> "$next"
  printf '%s\n' "$FRR_END" >> "$next"

  if [ -f "$FRR_CONFIG" ] && cmp -s "$next" "$FRR_CONFIG"; then
    rm -f "$next"
    return
  fi

  if ! prepare_frr_service; then
    rm -f "$next"
    return
  fi
  if ! install_frr_config "$next"; then
    log "BGP reconcile failed: FRR service could not be restarted"
    return
  fi
  log "Applied export-only BGP advertisements for $(printf '%s' "$advertised" | jq 'length') RP Network CIDRs"
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
    log "Gate token was revoked or rejected; tunnel and BGP advertisements disabled"
    down_tunnel
    disable_bgp
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
  RP_NETWORK_CIDRS="$(printf '%s' "$CONFIG" | jq -c '[.networks[]?.cidr]')"


  if [ "$(printf '%s' "$ALLOWED_IPS" | jq 'length')" -eq 0 ]; then
    down_tunnel
  else
    write_wireguard_config "$CONFIG"
    ALLOW_LAN_TO_RP="$(printf '%s' "$CONFIG" | jq -r '.allowLanToRp // true')"
    ALLOW_RP_TO_LAN="$(printf '%s' "$CONFIG" | jq -r '.allowRpToLan // false')"
    SERVER_TUNNEL_SOURCE="$(printf '%s' "$CONFIG" | jq -r '.serverTunnelAddress // ""' | cut -d/ -f1)"
    sync_firewall "$LAN_CIDRS" "$RP_NETWORK_CIDRS" "$ALLOW_LAN_TO_RP" "$ALLOW_RP_TO_LAN" "$SERVER_TUNNEL_SOURCE"
  fi
  sync_bgp "$CONFIG" "$LAN_ADDRESSES"

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
