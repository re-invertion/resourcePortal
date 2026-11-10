import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Install a dedicated LAN Attachments agent; routed Site VPN is unsupported. */
export function resourcePortalGateInstallerScript() {
  const lanAgent = readFileSync(join(__dirname, "gate-lan-agent.py"), "utf8");
  const managedUplink = readFileSync(join(__dirname, "gate-managed-uplink.py"), "utf8");
  const leaseAgent = readFileSync(join(__dirname, "gate-authorization-lease.py"), "utf8");
  return String.raw`#!/usr/bin/env bash
set -euo pipefail
API_URL=""
TOKEN=""
INTERVAL=30
UPLINK_DEVICE=""
SKIP_MANAGED_UPLINK=0
UPDATE_ONLY=0
AGENT_VERSION="gate-l2-v4"
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
    --uplink-device) UPLINK_DEVICE="__RP_SHELL_EXPAND__2:-}"; shift 2 ;;
    --skip-managed-uplink) SKIP_MANAGED_UPLINK=1; shift ;;
    --update) UPDATE_ONLY=1; SKIP_MANAGED_UPLINK=1; shift ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "Run as root"
if [ "$UPDATE_ONLY" -eq 1 ]; then
  [ -s "$STATE_FILE" ] && [ -s "$PRIVATE_KEY" ] &&
    [ -f "$AGENT_BIN" ] || die "Existing Gate identity or executable missing; update refused"
  STORED_URL="$(jq -er '.apiUrl' "$STATE_FILE")"
  [ -z "$API_URL" ] || [ "$API_URL" = "$STORED_URL" ] ||
    die "Update may not switch enrolled API origin"
  API_URL="$STORED_URL"
  [ -z "$TOKEN" ] || die "--update never accepts a new enrollment token"
else
  [ -n "$API_URL" ] && [ -n "$TOKEN" ] || die "--url and --token required"
  [[ "$INTERVAL" =~ ^[0-9]+$ ]] && [ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 120 ] ||
    die "Invalid heartbeat interval"
fi
API_URL="__RP_SHELL_EXPAND__API_URL%/}"
install_packages() {
  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y curl jq wireguard-tools iproute2 nftables python3 python3-yaml ca-certificates
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
if [ "$UPDATE_ONLY" -eq 0 ]; then
  install_packages
else
  for tool in curl jq wg wg-quick python3 nft ip systemctl; do
    command -v "$tool" >/dev/null || die "Existing Gate update missing dependency: $tool"
  done
  # Never touch the physical management uplink or enroll a new Gate during update.
  BACKUP_DIR="$(mktemp -d /var/backups/resourceportal-gate-XXXXXX)"
  for path in "$AGENT_BIN" "$SERVICE_FILE" \
    /usr/local/sbin/resourceportal-gate-lan.py \
    /usr/local/sbin/resourceportal-gate-uplink \
    /usr/local/sbin/resourceportal-gate-authorization-lease.py; do
    if [ -f "$path" ]; then
      install -m 0700 -p "$path" "$BACKUP_DIR/$(basename "$path")"
    fi
  done
fi
command -v systemctl >/dev/null || die "systemd is required"
install -d -m 0700 "$STATE_DIR"
install -d -m 0700 /etc/wireguard
if [ ! -s "$PRIVATE_KEY" ]; then umask 077; wg genkey > "$PRIVATE_KEY"; fi
chmod 0600 "$PRIVATE_KEY"
if [ "$UPDATE_ONLY" -eq 1 ]; then
  AGENT_TOKEN="$(jq -er .agentToken "$STATE_FILE")"
  GATE_ID="$(jq -er .gateId "$STATE_FILE")"
  # The existing enrolled machine bearer must be recognized by the upgraded
  # server before any local executable is overwritten.
  CONFIG_RESPONSE="$(curl -fsS --max-time 20 -H "authorization: Bearer $AGENT_TOKEN" \
    "$API_URL/networking/gates/agent/config")" ||
    die "Existing Gate bearer not accepted by RP; update refused"
  printf '%s' "$CONFIG_RESPONSE" | jq -e --arg id "$GATE_ID" \
    '.gateId==$id and .lanAttachmentProtocol==1 and .revoked!=true and
     (.supportedAgentVersions | type=="array" and index("gate-l2-v4")!=null)' >/dev/null ||
    die "Existing Gate identity or v4 server capability mismatch"
else
  PUBLIC_KEY="$(wg pubkey < "$PRIVATE_KEY")"
  PAYLOAD="$(jq -cn --arg token "$TOKEN" --arg key "$PUBLIC_KEY" \
    '{token:$token,publicKey:$key,agentVersion:"gate-l2-v4"}')"
  RESPONSE="$(curl -fsS --max-time 20 -H 'content-type: application/json' -X POST \
    --data "$PAYLOAD" "$API_URL/networking/gates/enroll")" || die "LAN enrollment failed"
  AGENT_TOKEN="$(printf '%s' "$RESPONSE" | jq -er .agentToken)"
  GATE_ID="$(printf '%s' "$RESPONSE" | jq -er .gateId)"
  umask 077
  jq -cn --arg api "$API_URL" --arg token "$AGENT_TOKEN" \
    --arg gate "$GATE_ID" --argjson interval "$INTERVAL" \
    '{apiUrl:$api,agentToken:$token,gateId:$gate,interval:$interval}' > "$STATE_FILE"
  chmod 0600 "$STATE_FILE"
fi

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

cat > /usr/local/sbin/resourceportal-gate-authorization-lease.py <<'RP_GATE_LEASE_PYTHON'
__RP_GATE_LEASE_PYTHON__
RP_GATE_LEASE_PYTHON
chmod 0700 /usr/local/sbin/resourceportal-gate-authorization-lease.py

cat > "$AGENT_BIN" <<'RP_GATE_AGENT'
#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="/etc/resourceportal-gate/state.json"
PRIVATE_KEY="/etc/resourceportal-gate/private.key"
WG_CONF="/etc/wireguard/rp-gate.conf"
WG_INTERFACE="rp-gate"
LAN_AGENT="/usr/local/sbin/resourceportal-gate-lan.py"
LEASE_AGENT="/usr/local/sbin/resourceportal-gate-authorization-lease.py"
WATCHDOG_PID=""
RETRY_DELAY=2
log() { printf '[RP Gate LAN] %s\n' "$*"; }
revoke_lan() {
  python3 "$LAN_AGENT" --revoke-all || { log "LAN revocation failed; state retained"; return 1; }
}
down_tunnel() { wg-quick down "$WG_INTERFACE" >/dev/null 2>&1 || true; }
shutdown() {
  python3 "$LEASE_AGENT" --clear || true
  if [ -n "$WATCHDOG_PID" ]; then kill "$WATCHDOG_PID" 2>/dev/null || true; fi
  revoke_lan || true
  down_tunnel
}
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

# A process/host restart never inherits an old grant, even if the kernel
# retained an old RP-owned tunnel. A successful new heartbeat must reauthorize.
shutdown
python3 "$LEASE_AGENT" --watch &
WATCHDOG_PID=$!

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
  # Do not report collector execution failures as a healthy empty proof set.
  # Emit only a fixed diagnostic code, never Python stderr or bearer data.
  # Collector emits only an allow-listed reason and count; no raw stderr is sent.
  if ! OBSERVED_RESULT="$(python3 "$LAN_AGENT" --observed-attachment-diagnostics 2>/dev/null)"; then
    log "LAN proof collection failed (gate observation unavailable)"
    OBSERVED_RESULT='{"proofs":[],"diagnostic":{"reasonCode":"collector_error","rawCount":0,"errorCode":"collector_execution_failed"}}'
  fi
  if ! printf '%s' "$OBSERVED_RESULT" | jq -e '.proofs | type == "array"' >/dev/null 2>&1; then
    OBSERVED_RESULT='{"proofs":[],"diagnostic":{"reasonCode":"collector_error","rawCount":0,"errorCode":"invalid_collector_output"}}'
  fi
  OBSERVED_L2="$(printf '%s' "$OBSERVED_RESULT" | jq -c '.proofs')"
  OBSERVED_DIAG="$(printf '%s' "$OBSERVED_RESULT" | jq -c '.diagnostic')"
  APPLIED_AT="$(python3 "$LAN_AGENT" --applied-at 2>/dev/null || printf '0')"
  if ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    log "Authorization watchdog unavailable; failing closed"
    exit 1
  fi
  CHALLENGE="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  HEARTBEAT="$(jq -cn --arg nonce "$CHALLENGE" --argjson observation "$OBSERVED_LAN" --argjson l2 "$OBSERVED_L2" --argjson diag "$OBSERVED_DIAG" --argjson applied "$APPLIED_AT" \
    '{agentVersion:"gate-l2-v4",leaseNonce:$nonce,lanObservation:$observation,lanAttachmentProofs:$l2,lanProofDiagnostic:$diag} + (if $applied > 0 then {lanAppliedAtMs:$applied} else {} end)')"
  # A 401/403 is an explicit authenticated-access denial, unlike an
  # ambiguous ingress 404/502 or broken TLS transport. Never extend an
  # offline lease after an explicit authorization rejection.
  RAW_RESPONSE=""
  HTTP_CODE="000"
  if RAW_RESPONSE="$(curl -sS --max-time 20 -w $'\n%{http_code}' \
    -H "authorization: Bearer $AGENT_TOKEN" \
    -H 'content-type: application/json' -X POST \
    --data "$HEARTBEAT" \
    "$API_URL/networking/gates/agent/heartbeat")"; then
    HTTP_CODE="__RP_SHELL_EXPAND__RAW_RESPONSE##*$'\n'}"
  fi
  RESPONSE="__RP_SHELL_EXPAND__RAW_RESPONSE%$'\n'*}"
  if [ "$HTTP_CODE" = "200" ]; then
    # A valid HTTP response without the fresh client challenge is untrusted.
    if ! printf '%s' "$RESPONSE" | jq -e --arg gate "$GATE_ID" --arg nonce "$CHALLENGE" \
      '.gateId==$gate and .authorizationLease.protocol==1 and
       .authorizationLease.gateId==$gate and .authorizationLease.nonce==$nonce' >/dev/null; then
      python3 "$LEASE_AGENT" --clear || true
      revoke_lan || true
      down_tunnel
      log "Untrusted heartbeat response; forwarding revoked"
    elif ! apply_config "$RESPONSE"; then
      python3 "$LEASE_AGENT" --clear || true
      revoke_lan || true
      down_tunnel
      log "LAN policy invalid or tunnel unavailable"
    else
      # The current server may provide no offline grant while provisioning;
      # this is NOT a failure of the live authorized configuration.
      if printf '%s' "$RESPONSE" | python3 "$LEASE_AGENT" --renew --nonce "$CHALLENGE"; then
        # Extend only the exact existing authorized nft source timers
        # to the fixed lease deadline; never recreate WireGuard or bridges.
        if ! python3 "$LAN_AGENT" --refresh-authorized-sources; then
          python3 "$LEASE_AGENT" --clear || true
          revoke_lan || true
          down_tunnel
          log "Authorized source refresh failed; forwarding revoked"
        fi
      else
        python3 "$LEASE_AGENT" --clear || true
        # A new static-IP attachment requires ARP/bootstrap to become Active.
        # Permit a short, single-heartbeat source grant while the authenticated
        # control plane is reachable; it cannot be renewed during an outage.
        if ! python3 "$LAN_AGENT" --refresh-live-sources; then
          revoke_lan || true
          down_tunnel
          log "Live-only source refresh failed; forwarding revoked"
        fi
        log "No offline lease; source policy limited to live control plane"
      fi
      RETRY_DELAY=2
    fi
    DELAY="$INTERVAL"
  elif [[ "$HTTP_CODE" =~ ^(400|401|403|405|409|410|412|422)$ ]]; then
    python3 "$LEASE_AGENT" --clear || true
    revoke_lan || true
    down_tunnel
    log "Gate authorization rejected by API; forwarding revoked immediately"
    DELAY="$INTERVAL"
  else
    if python3 "$LEASE_AGENT" --valid; then
      log "Control plane Degraded; continuing only existing leased forwarding"
    else
      revoke_lan || true
      down_tunnel
      log "Heartbeat failed without valid authorization; forwarding revoked"
    fi
    DELAY=$((RETRY_DELAY + RANDOM % 4))
    RETRY_DELAY=$((RETRY_DELAY * 2))
    if [ "$RETRY_DELAY" -gt 30 ]; then RETRY_DELAY=30; fi
  fi
  sleep "$DELAY" &
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
if [ "$UPDATE_ONLY" -eq 1 ]; then
  log "LAN Gate $GATE_ID upgraded in place; backups: $BACKUP_DIR"
else
  log "LAN Gate enrolled as $GATE_ID"
fi

# One-command enrollment prepares a managed physical LAN bridge.
# Wi-Fi is neither bridged nor used as a recovery prerequisite. A detached
# systemd migration and verifier survive disconnection of this SSH process.
if [ "$SKIP_MANAGED_UPLINK" -eq 0 ]; then
  UPLINK="/usr/local/sbin/resourceportal-gate-uplink"
  if "$UPLINK" refresh >/dev/null 2>&1; then
    log "Verified shared LAN uplink already exists; keeping it unchanged"
  else
    mapfile -t CANDIDATES < <("$UPLINK" devices | jq -r '.[]')
    if [ -n "$UPLINK_DEVICE" ]; then
      printf '%s\n' "__RP_SHELL_EXPAND__CANDIDATES[@]}" | grep -Fxq "$UPLINK_DEVICE" ||
        die "Selected uplink is not an eligible connected physical Ethernet: $UPLINK_DEVICE"
    elif [ "__RP_SHELL_EXPAND__#CANDIDATES[@]}" -eq 1 ]; then
      UPLINK_DEVICE="__RP_SHELL_EXPAND__CANDIDATES[0]}"
    elif [ "__RP_SHELL_EXPAND__#CANDIDATES[@]}" -eq 0 ]; then
      log "No connected physical Ethernet found; Gate enrolled but LAN bridge not configured"
      log "Connect the Ethernet and run: sudo $UPLINK preflight --device <device>"
    else
      log "Multiple physical Ethernet ports are available:"
      for candidate in "__RP_SHELL_EXPAND__CANDIDATES[@]}"; do
        log "  $candidate"
      done
      [ -r /dev/tty ] || die "Select with --uplink-device <name> (no interactive terminal)"
      while :; do
        printf 'Choose the Gate LAN Ethernet port: ' > /dev/tty
        IFS= read -r UPLINK_DEVICE < /dev/tty ||
          die "No Ethernet selection entered"
        printf '%s\n' "__RP_SHELL_EXPAND__CANDIDATES[@]}" | grep -Fxq "$UPLINK_DEVICE" && break
        log "Invalid Ethernet selection: $UPLINK_DEVICE"
      done
    fi
    if [ -n "$UPLINK_DEVICE" ]; then
      log "Preparing shared LAN bridge on $UPLINK_DEVICE; SSH may reconnect shortly"
      PLAN="$("$UPLINK" preflight --device "$UPLINK_DEVICE")" ||
        die "Uplink preflight rejected unsafe Ethernet configuration"
      printf '%s\n' "$PLAN" | jq -e         '.applySupported == true and .networkCidr and .gateway and .device' >/dev/null ||
        die "Shared uplink requires a supported network configuration"
      MANAGER="$(printf '%s' "$PLAN" | jq -er .manager)"
      if [ "$MANAGER" = "NetplanNetworkManager" ]; then
        die "Netplan takeover is not certified for automatic enrollment; use a native NM profile or supported networkd"
      fi
      "$UPLINK" apply --device "$UPLINK_DEVICE" ||
        die "Shared uplink migration was not scheduled; inspect rollback logs"
      log "Shared Ethernet migration scheduled; authenticated auto-confirm and rollback armed"
    fi
  fi
fi
`.replace("__RP_GATE_LAN_PYTHON__", lanAgent).replace("__RP_GATE_UPLINK_PYTHON__", managedUplink)
    .replace("__RP_GATE_LEASE_PYTHON__", leaseAgent).replaceAll("__RP_SHELL_EXPAND__", "${");
}
