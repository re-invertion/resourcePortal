#!/usr/bin/env bash
# Disposable four-namespace Ethernet-over-WireGuard DHCP integration smoke.
set -euo pipefail
export PATH="/usr/sbin:/sbin:$PATH"
APP="rpa-$"; APP2="rp2-$"; RP="rpr-$"; GATE="rpg-$"; LAN="rpl-$"
TMP="$(mktemp -d)"
SERVER_KEY_APPARMOR=""
CLIENT_KEY_APPARMOR=""
FAULT_PID=""
REAL_FAULT="$(printenv RP_LAN_REAL_CONTROL_PLANE_FAULT 2>/dev/null || printf 0)"
case "$REAL_FAULT" in 0|1) ;; *) echo "Invalid real fault selector" >&2; exit 2;; esac
# Full-duration kernel lease continuity only on explicitly selected changes.
LONG_LEASE_SMOKE="$(printenv RP_LAN_LONG_LEASE_SMOKE 2>/dev/null || printf 0)"
case "$LONG_LEASE_SMOKE" in 0|1) ;; *) echo "Invalid long lease smoke selector" >&2; exit 2;; esac
DHCP_DURATION="5m"
if [ "$LONG_LEASE_SMOKE" = 1 ]; then DHCP_DURATION="15m"; fi
if [ "$REAL_FAULT" = 1 ] && [ "$LONG_LEASE_SMOKE" != 1 ]; then
  echo "Real API fault requires the long lease smoke" >&2; exit 2
fi
MAC="02:aa:bb:cc:dd:ee"; MAC2="02:aa:bb:cc:dd:ef"
APP_IP="10.200.42.12"; RP_IP="10.200.42.20"
APP2_IP="10.200.43.12"; RP2_IP="10.200.43.20"
SV_IP="100.96.90.1"; CL_IP="100.96.90.2"
log() { printf '[l2-dhcp] %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ns() { local net="$1"; shift; sudo -n ip netns exec "$net" "$@"; }
cleanup() {
  set +e
  # The fault driver has its own EXIT trap that always restores the isolated
  # API. Never leave the API stopped if an event assertion fails.
  if [ -n "$FAULT_PID" ]; then
    kill "$FAULT_PID" 2>/dev/null || true
    wait "$FAULT_PID" 2>/dev/null || true
    [ ! -f "$TMP/controlplane.log" ] || cat "$TMP/controlplane.log" >&2
  fi
  for net in "$APP" "$APP2" "$RP" "$GATE" "$LAN"; do
    sudo -n ip netns pids "$net" 2>/dev/null | xargs -r sudo -n kill >/dev/null 2>&1 || true
    sudo -n ip netns del "$net" >/dev/null 2>&1 || true
  done
  if [ -n "$SERVER_KEY_APPARMOR" ]; then
    sudo -n rm -f -- "$SERVER_KEY_APPARMOR" >/dev/null 2>&1 || true
  fi
  if [ -n "$CLIENT_KEY_APPARMOR" ]; then
    sudo -n rm -f -- "$CLIENT_KEY_APPARMOR" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
for binary in ip nsenter wg dnsmasq busybox python3 ping nft; do
  command -v "$binary" >/dev/null || fail "missing $binary"
done
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$REPO_ROOT/test" -p "test_gate*py" -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$REPO_ROOT/test" -p "test_remote_lan_lease_soak.py" -v
sudo -n true || fail "passwordless sudo required"
read -r APP_DEV WAN_DEV APP_KEY WAN_KEY GATE_BRIDGE < <(python3 - <<'PY'
import hashlib
tenant="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
gate="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
attachment="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
h=hashlib.sha256(f"{tenant}:{gate}:{attachment}".encode()).digest()
b=hashlib.sha256(f"{gate}:eth1".encode()).hexdigest()[:8]
print("rp-a-"+h[:4].hex(),"rp-l2-"+h[:4].hex(),
      (int.from_bytes(h[8:12],"big")%4294967295)+1,
      (int.from_bytes(h[4:8],"big")%4294967295)+1,
      "rp-gb-"+b)
PY
)
BRIDGE="rp-b-$(echo "$APP_DEV" | cut -c6-)"
read -r APP2_DEV WAN2_DEV APP2_KEY WAN2_KEY < <(python3 - <<'PY'
import hashlib
tenant="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
gate="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
attachment="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
h=hashlib.sha256(f"{tenant}:{gate}:{attachment}".encode()).digest()
print("rp-a-"+h[:4].hex(),"rp-l2-"+h[:4].hex(),
      (int.from_bytes(h[8:12],"big")%4294967295)+1,
      (int.from_bytes(h[4:8],"big")%4294967295)+1)
PY
)
BRIDGE2="rp-b-$(echo "$APP2_DEV" | cut -c6-)"
# Use the actual production Gate agent nft generator in disposable netns.
# Provisioning permits DHCP and ARP probes only; Active permits the confirmed
# address; no policy grants any other source on the customer's LAN.
gate_source_policy() {
  local attachment="$1" address="$2" mode="$3" expiry="$4"
  ns "$GATE" env RP_NFT_AGENT="$REPO_ROOT/packages/resourceportal-api/src/networking/gate-lan-agent.py" \
    RP_NFT_ATTACHMENT="$attachment" RP_NFT_ADDRESS="$address" RP_NFT_MODE="$mode" \
    RP_NFT_EXPIRY="$expiry" python3 - <<'PY_GATE_NFT'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("rp_gate_source_smoke", os.environ["RP_NFT_AGENT"])
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
gate, tenant = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
aid = os.environ["RP_NFT_ATTACHMENT"]
tunnel, _, chain, _ = mod.names(gate, tenant, aid, "eth1")
stage, address, expiry = os.environ["RP_NFT_MODE"], os.environ["RP_NFT_ADDRESS"], os.environ["RP_NFT_EXPIRY"]
item = {"lanCidr":"192.168.90.0/24", "addressMode":"Static" if stage=="Static" else "DHCP",
        "status": "Provisioning" if stage in ("Provisioning", "Revoked") else "Active",
        "staticAddress":address+"/24" if stage=="Static" else None,
        "verifiedAddress":address if stage=="Active" else None,
        "leaseExpiresAt":expiry if stage=="Active" else None}
if stage != "Provisioning":
    mod.nft_remove(chain)
mod.nft_install(chain, tunnel, "02:aa:bb:cc:dd:ef" if aid.endswith("bbbbbbbbbbbb") else "02:aa:bb:cc:dd:ee", item)
PY_GATE_NFT
}
SOURCE_AID="aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa"
SOURCE_BID="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb"
source_expiry() {
  python3 - "$1" <<'PY_EXPIRY'
from datetime import datetime, timezone, timedelta
import sys
print((datetime.now(timezone.utc)+timedelta(seconds=int(sys.argv[1]))).isoformat())
PY_EXPIRY
}
for net in "$APP" "$APP2" "$RP" "$GATE" "$LAN"; do
  sudo -n ip netns add "$net"
  ns "$net" ip link set lo up
done
sudo -n ip link add aa0 type veth peer name ar0
sudo -n ip link set aa0 netns "$APP"
sudo -n ip link set ar0 netns "$RP"
ns "$APP" ip addr add "$APP_IP/24" dev aa0
ns "$RP" ip addr add "$RP_IP/24" dev ar0
ns "$APP" ip link set aa0 up
ns "$RP" ip link set ar0 up
sudo -n ip link add ab0 type veth peer name rb0
sudo -n ip link set ab0 netns "$APP2"
sudo -n ip link set rb0 netns "$RP"
ns "$APP2" ip addr add "$APP2_IP/24" dev ab0
ns "$RP" ip addr add "$RP2_IP/24" dev rb0
ns "$APP2" ip link set ab0 up
ns "$RP" ip link set rb0 up
sudo -n ip link add ru0 type veth peer name gu0
sudo -n ip link set ru0 netns "$RP"
sudo -n ip link set gu0 netns "$GATE"
ns "$RP" ip addr add 172.31.90.1/30 dev ru0
ns "$GATE" ip addr add 172.31.90.2/30 dev gu0
ns "$RP" ip link set ru0 up
ns "$GATE" ip link set gu0 up
wg genkey | tee "$TMP/s.key" | wg pubkey > "$TMP/s.pub"
wg genkey | tee "$TMP/c.key" | wg pubkey > "$TMP/c.pub"
ns "$RP" ip link add wg0 type wireguard
ns "$GATE" ip link add rp-gate type wireguard
# Ubuntu 26.04's wg AppArmor profile allows private-key reads only in
# /etc/wireguard, not /tmp, /run or /dev/stdin. Keep files root-owned 0600.
sudo -n mkdir -p /etc/wireguard
SERVER_KEY_APPARMOR="$(sudo -n mktemp /etc/wireguard/rp-l2-server-smoke.XXXXXXXX)"
CLIENT_KEY_APPARMOR="$(sudo -n mktemp /etc/wireguard/rp-l2-client-smoke.XXXXXXXX)"
cat "$TMP/s.key" | sudo -n tee "$SERVER_KEY_APPARMOR" >/dev/null
cat "$TMP/c.key" | sudo -n tee "$CLIENT_KEY_APPARMOR" >/dev/null
sudo -n chmod 0600 "$SERVER_KEY_APPARMOR" "$CLIENT_KEY_APPARMOR"
sudo -n nsenter --net="/run/netns/$RP" -- \
  wg set wg0 private-key "$SERVER_KEY_APPARMOR" listen-port 55051 \
  peer "$(cat "$TMP/c.pub")" allowed-ips "$CL_IP/32" endpoint 172.31.90.2:55052
sudo -n nsenter --net="/run/netns/$GATE" -- \
  wg set rp-gate private-key "$CLIENT_KEY_APPARMOR" listen-port 55052 \
  peer "$(cat "$TMP/s.pub")" allowed-ips "$SV_IP/32" endpoint 172.31.90.1:55051
ns "$RP" ip addr add "$SV_IP/30" dev wg0
ns "$GATE" ip addr add "$CL_IP/30" dev rp-gate
ns "$RP" ip link set wg0 up
ns "$GATE" ip link set rp-gate up
sudo -n ip link add eth1 type veth peer name lan0
sudo -n ip link set eth1 netns "$GATE"
sudo -n ip link set lan0 netns "$LAN"
ns "$GATE" ip link set eth1 up
ns "$LAN" ip addr add 192.168.90.1/24 dev lan0
ns "$LAN" ip link set lan0 up
[ -z "$(ns "$GATE" ip -4 -o addr show dev eth1)" ] || fail "management address on handoff"
ns "$APP" ip link add "$APP_DEV" type gretap local "$APP_IP" remote "$RP_IP" key "$APP_KEY" dev aa0 ttl 64
ns "$APP" ip link set dev "$APP_DEV" mtu 1180
ns "$APP" ip link set dev "$APP_DEV" address "$MAC"
ns "$APP" ip link set "$APP_DEV" up
ns "$RP" ip link add "$APP_DEV" type gretap local "$RP_IP" remote "$APP_IP" key "$APP_KEY" dev ar0 ttl 64
ns "$RP" ip link set "$APP_DEV" mtu 1180 up
ns "$RP" ip link add "$WAN_DEV" type gretap local "$SV_IP" remote "$CL_IP" key "$WAN_KEY" dev wg0 ttl 64
ns "$RP" ip link set "$WAN_DEV" mtu 1280 up
ns "$RP" ip link add "$BRIDGE" type bridge stp_state 1
ns "$RP" ip link set "$APP_DEV" master "$BRIDGE"
ns "$RP" ip link set "$WAN_DEV" master "$BRIDGE"
ns "$RP" ip link set "$BRIDGE" up
ns "$GATE" ip link add "$WAN_DEV" type gretap local "$CL_IP" remote "$SV_IP" key "$WAN_KEY" dev rp-gate ttl 64
ns "$GATE" ip link set "$WAN_DEV" mtu 1280 up
gate_source_policy "$SOURCE_AID" "" "Provisioning" ""
ns "$GATE" ip link add "$GATE_BRIDGE" type bridge stp_state 1
ns "$GATE" ip link set "$WAN_DEV" master "$GATE_BRIDGE"
ns "$GATE" ip link set eth1 master "$GATE_BRIDGE"
ns "$GATE" ip link set "$GATE_BRIDGE" up
# Second isolated application, second independent GRETAP/WireGuard bridge
# endpoint. Both MACs reach the same customer bridge, never one another's
# application namespace or Docker default route.
ns "$APP2" ip link add "$APP2_DEV" type gretap local "$APP2_IP" remote "$RP2_IP" key "$APP2_KEY" dev ab0 ttl 64
ns "$APP2" ip link set dev "$APP2_DEV" mtu 1180
ns "$APP2" ip link set dev "$APP2_DEV" address "$MAC2"
ns "$APP2" ip link set "$APP2_DEV" up
ns "$RP" ip link add "$APP2_DEV" type gretap local "$RP2_IP" remote "$APP2_IP" key "$APP2_KEY" dev rb0 ttl 64
ns "$RP" ip link set "$APP2_DEV" mtu 1180 up
ns "$RP" ip link add "$WAN2_DEV" type gretap local "$SV_IP" remote "$CL_IP" key "$WAN2_KEY" dev wg0 ttl 64
ns "$RP" ip link set "$WAN2_DEV" mtu 1280 up
ns "$RP" ip link add "$BRIDGE2" type bridge stp_state 1
ns "$RP" ip link set "$APP2_DEV" master "$BRIDGE2"
ns "$RP" ip link set "$WAN2_DEV" master "$BRIDGE2"
ns "$RP" ip link set "$BRIDGE2" up
ns "$GATE" ip link add "$WAN2_DEV" type gretap local "$CL_IP" remote "$SV_IP" key "$WAN2_KEY" dev rp-gate ttl 64
ns "$GATE" ip link set "$WAN2_DEV" mtu 1280 up
gate_source_policy "$SOURCE_BID" "" "Provisioning" ""
ns "$GATE" ip link set "$WAN2_DEV" master "$GATE_BRIDGE"
# STP is intentionally enabled on both bridges to prevent remote L2 loops.
# A freshly created Linux STP port starts in blocking/listening/learning and
# normally needs ~30 seconds before DHCP broadcasts may cross it. Starting
# udhcpc immediately races its bounded retry budget against STP convergence.
# Do not disable STP or pretend a DHCP lease exists before the real dataplane
# proves it.
log "Waiting for encrypted transport and all L2 bridge ports to forward"
ready=0
for attempt in $(seq 1 75); do
  ready=1
  for pair in "$RP:$APP_DEV" "$RP:$WAN_DEV" "$RP:$APP2_DEV" "$RP:$WAN2_DEV" "$GATE:$WAN_DEV" "$GATE:$WAN2_DEV" "$GATE:eth1"; do
    net="${pair%%:*}"; port="${pair#*:}"
    if ! ns "$net" bridge link show dev "$port" | grep -Eq 'state forwarding'; then
      ready=0
      break
    fi
  done
  if [ "$ready" -eq 1 ]; then break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  ns "$RP" bridge link show >&2 || true
  ns "$GATE" bridge link show >&2 || true
  fail "STP bridge ports did not enter forwarding state"
fi
# Exercise the encrypted underlay before sending the first customer DHCP
# broadcast; the GRETAP tunnel must not be mistaken for an unencrypted link.
if ! ns "$RP" ping -q -c 3 -W 2 -I wg0 "$CL_IP" >/dev/null 2>&1; then
  ns "$RP" wg show wg0 >&2 || true
  ns "$GATE" wg show rp-gate >&2 || true
  fail "no encrypted WireGuard underlay connectivity"
fi
log "PASS STP forwarding and encrypted underlay readiness"
ns "$LAN" dnsmasq --keep-in-foreground --no-hosts --no-resolv --bind-interfaces --interface=lan0 \
  --port=0 --dhcp-range=192.168.90.20,192.168.90.40,255.255.255.0,"$DHCP_DURATION" \
  --dhcp-authoritative --dhcp-host="$MAC,192.168.90.23" --dhcp-host="$MAC2,192.168.90.24" \
  --dhcp-leasefile="$TMP/dnsmasq.leases" --log-dhcp --log-facility=- \
  > "$TMP/dhcp.log" 2>&1 &
sleep 1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# udhcpc executes -s as a binary, not via "sh". Repository source files
# are stored mode 0644, while the production image installs the hook
# executable (0755). Mirror the production file mode in the isolated smoke;
# otherwise udhcpc can report a lease but silently skip applying the IP.
install -m 0755 "$ROOT/packages/resourceportal-api/src/networking/remote-lan-dhcp.sh" \
  "$TMP/remote-lan-dhcp.sh"
test -x "$TMP/remote-lan-dhcp.sh" || fail "DHCP hook must be executable"
ns "$APP" env RP_REMOTE_LAN_CIDR=192.168.90.0/24 busybox udhcpc -f -n -q -T 2 -t 15 -i "$APP_DEV" \
  -s "$TMP/remote-lan-dhcp.sh" > "$TMP/lease.log" 2>&1 ||
  {
    cat "$TMP/lease.log" "$TMP/dhcp.log" >&2
    ns "$APP" ip -s link show dev "$APP_DEV" >&2 || true
    ns "$RP" ip -s link show dev "$APP_DEV" >&2 || true
    ns "$RP" ip -s link show dev "$WAN_DEV" >&2 || true
    ns "$GATE" ip -s link show dev "$WAN_DEV" >&2 || true
    ns "$RP" bridge link show >&2 || true
    ns "$GATE" bridge link show >&2 || true
    ns "$RP" wg show wg0 >&2 || true
    ns "$GATE" wg show rp-gate >&2 || true
    fail "no customer DHCP lease"
  }
# BusyBox udhcpc may return success even when its external hook rejects a
# bound lease. Always show the hook/DHCP evidence if the address is absent;
# never treat a successful udhcpc process exit as proof of a configured NIC.
if ! ns "$APP" ip -4 -o addr show dev "$APP_DEV" | grep -q "192.168.90.23/"; then
  echo "--- udhcpc lease / DHCP hook output ---" >&2
  cat "$TMP/lease.log" >&2 || true
  echo "--- customer dnsmasq output ---" >&2
  cat "$TMP/dhcp.log" >&2 || true
  echo "--- actual application NIC / neighbor state ---" >&2
  ns "$APP" ip -4 addr show dev "$APP_DEV" >&2 || true
  ns "$APP" ip -s link show dev "$APP_DEV" >&2 || true
  ns "$APP" ip -4 neigh show dev "$APP_DEV" >&2 || true
  echo "--- STP and authenticated transport ---" >&2
  ns "$RP" bridge link show >&2 || true
  ns "$GATE" bridge link show >&2 || true
  ns "$RP" wg show wg0 >&2 || true
  ns "$GATE" wg show rp-gate >&2 || true
  fail "application did not get customer DHCP address"
fi
# dnsmasq normally logs to syslog, not the redirected stdout log.
# Prove the customer-side server recorded the MAC->IP lease in its own
# authoritative lease database; logging alone is not data-plane evidence.
server_lease=0
for attempt in $(seq 1 10); do
  if [ -f "$TMP/dnsmasq.leases" ] &&
     awk -v mac="$MAC" 'tolower($2)==tolower(mac) && $3=="192.168.90.23"{found=1} END{exit !found}' "$TMP/dnsmasq.leases"; then
    server_lease=1
    break
  fi
  sleep 1
done
if [ "$server_lease" -ne 1 ]; then
  echo "--- customer DHCP server log ---" >&2
  cat "$TMP/dhcp.log" >&2 || true
  echo "--- customer DHCP lease database ---" >&2
  cat "$TMP/dnsmasq.leases" >&2 || true
  fail "customer DHCP server has no lease for application MAC and expected IP"
fi
log "PASS customer DHCP server recorded application MAC and expected IP"
log "PASS stable MAC and remote LAN DHCP"
gate_source_policy "$SOURCE_AID" "192.168.90.23" "Active" "$(source_expiry 240)"
ns "$APP" ping -c 3 -W 2 -I "$APP_DEV" 192.168.90.1 ||
  fail "application cannot reach remote LAN"
ns "$APP" ip -4 neigh show dev "$APP_DEV" | grep -q "192.168.90.1" ||
  fail "application did not learn remote LAN ARP"
log "PASS Ethernet ARP and LAN IP"
# Send a raw ARP reply with the *assigned Ethernet MAC* and capture on
# customer's physical LAN. Verify the same instrumentation sees the valid
# lease's ARP while a gateway-impersonation ARP does not cross the tunnel.
assert_arp_sender() {
  local advertised="$1" expected="$2"
  local ready="$TMP/arp-capture-ready"
  rm -f "$ready"
  ns "$LAN" env RP_ARP_READY="$ready" RP_ARP_SOURCE="$advertised" python3 - <<'PY_ARP_CAPTURE' &
import os, socket, sys, time
sock=socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0806))
sock.bind(("lan0", 0))
sock.settimeout(0.75)
open(os.environ["RP_ARP_READY"], "w").close()
source=socket.inet_aton(os.environ["RP_ARP_SOURCE"])
mac=bytes.fromhex("02aabbccddee")
end=time.monotonic()+4
while time.monotonic()<end:
    try:
        packet=sock.recv(4096)
    except socket.timeout:
        continue
    if (len(packet)>=42 and packet[12:14]==b"\x08\x06" and
        packet[6:12]==mac and packet[22:28]==mac and
        packet[28:32]==source):
        sys.exit(0)
sys.exit(1)
PY_ARP_CAPTURE
  local capture_pid="$!"
  local capture_ready=0
  for attempt in $(seq 1 35); do
    if [ -e "$ready" ]; then capture_ready=1; break; fi
    sleep 0.1
  done
  [ "$capture_ready" -eq 1 ] || fail "ARP capture could not start"
  ns "$APP" env RP_ARP_IF="$APP_DEV" RP_ARP_SOURCE="$advertised" python3 - <<'PY_ARP_SENDER'
import os, socket, struct, time
mac=bytes.fromhex("02aabbccddee")
src=socket.inet_aton(os.environ["RP_ARP_SOURCE"])
eth=b"\xff"*6+mac+b"\x08\x06"
arp=struct.pack("!HHBBH",1,0x800,6,4,2)+mac+src+b"\x00"*6+src
sock=socket.socket(socket.AF_PACKET,socket.SOCK_RAW)
sock.bind((os.environ["RP_ARP_IF"],0))
for _ in range(3):
    sock.send(eth+arp)
    time.sleep(0.15)
PY_ARP_SENDER
  if wait "$capture_pid"; then
    [ "$expected" = "pass" ] || fail "forged gateway ARP reached physical LAN"
  else
    [ "$expected" = "drop" ] || fail "valid leased ARP did not reach physical LAN"
  fi
}
assert_arp_sender "192.168.90.23" "pass"
assert_arp_sender "192.168.90.1" "drop"
log "PASS real WireGuard/Gate path permits own ARP but rejects gateway identity spoof"
# A second IPv4 address on the SAME approved MAC must never pass the Gate
# source policy. Without the fix this ping succeeds through the L2 tunnel.
ns "$APP" ip addr add 192.168.90.100/24 dev "$APP_DEV"
if ns "$APP" ping -c 2 -W 1 -I 192.168.90.100 192.168.90.1 >/dev/null 2>&1; then
  fail "forged IPv4 source crossed the customer's LAN"
fi
ns "$APP" ip addr del 192.168.90.100/24 dev "$APP_DEV"
log "PASS verified DHCP lease rejects forged IPv4 source"

# Independently lease and route a second application MAC over a separate
# tenant overlay and GRETAP key, sharing only the customer-facing Gate bridge.
ns "$APP2" env RP_REMOTE_LAN_CIDR=192.168.90.0/24 busybox udhcpc -f -n -q -T 2 -t 15 -i "$APP2_DEV" \
  -s "$TMP/remote-lan-dhcp.sh" > "$TMP/lease2.log" 2>&1 || {
    cat "$TMP/lease2.log" "$TMP/dhcp.log" >&2
    fail "second application did not obtain its independent DHCP lease"
  }
ns "$APP2" ip -4 -o addr show dev "$APP2_DEV" | grep -q '192.168.90.24/' ||
  fail "second application did not receive its reserved customer DHCP IP"
awk -v mac="$MAC2" 'tolower($2)==tolower(mac) && $3=="192.168.90.24"{found=1} END{exit !found}' "$TMP/dnsmasq.leases" ||
  fail "customer DHCP server did not record the second application MAC"
gate_source_policy "$SOURCE_BID" "192.168.90.24" "Active" "$(source_expiry 240)"
ns "$APP2" ping -c 3 -W 2 -I "$APP2_DEV" 192.168.90.1 ||
  fail "second application cannot reach customer LAN"
ns "$APP" ip -4 -o addr show dev "$APP_DEV" | grep -q '192.168.90.23/' ||
  fail "second DHCP attachment overwrote the first application's IP"
# Learned customer-side MAC entries must map to their own tunnel ports.
ns "$GATE" bridge fdb show dev "$WAN_DEV" | grep -qi "$MAC" ||
  fail "first application MAC was not learned on its own Gate tunnel"
ns "$GATE" bridge fdb show dev "$WAN2_DEV" | grep -qi "$MAC2" ||
  fail "second application MAC was not learned on its own Gate tunnel"
log "PASS two independent application DHCP leases, MACs, ARP and encrypted tunnels"

if [ "$LONG_LEASE_SMOKE" = 1 ]; then
  # This uses actual WG/GRETAP and the production nft generator. With
  # REAL_FAULT=1 it also stops the disposable API and churns real Traefik.
  # No kernel grant is renewed during the entire trial, including recovery.
  log "Beginning 443s bidirectional HA-like event test with no source renewals"
  wg_before="$(ns "$GATE" ip -o link show dev rp-gate | cut -d: -f1)"
  gretap_before="$(ns "$GATE" ip -o link show dev "$WAN2_DEV" | cut -d: -f1)"
  if [ "$REAL_FAULT" = 1 ]; then
    bash "$REPO_ROOT/scripts/run-remote-lan-real-controlplane-fault.sh" \
      "$TMP/fault-prepared" "$TMP/fault-lease" "$TMP/fault-outage" "$TMP/fault-restore" \
      >"$TMP/controlplane.log" 2>&1 &
    FAULT_PID="$!"
    prepared=0
    for i in $(seq 1 125); do
      if [ -f "$TMP/fault-prepared" ]; then prepared=1; break; fi
      if ! kill -0 "$FAULT_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    [ "$prepared" -eq 1 ] || { cat "$TMP/controlplane.log" >&2; fail "Real Traefik fault preflight failed"; }
  fi
  # Record original monotonic authorization instant BEFORE API shutdown.
  begin="$(python3 -c 'import time; print(time.monotonic())')"
  gate_source_policy "$SOURCE_BID" "192.168.90.24" "Active" "$(source_expiry 600)"
  ns "$APP2" ping -q -c 2 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null ||
    fail "Missing initial LAN data plane for 443s test"
  if [ "$REAL_FAULT" = 1 ]; then
    : > "$TMP/fault-lease"
    outage_ready=0
    for i in $(seq 1 75); do
      if [ -f "$TMP/fault-outage" ]; then outage_ready=1; break; fi
      if ! kill -0 "$FAULT_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    [ "$outage_ready" -eq 1 ] || { cat "$TMP/controlplane.log" >&2; fail "Real API/Traefik shutdown failed"; }
  fi

  ready="$TMP/ha-event-listener-ready"
  ns "$LAN" env RP_EVENT_READY="$ready" python3 -u     "$REPO_ROOT/scripts/remote-lan-lease-soak.py" receiver >"$TMP/events.log" 2>&1 &
  server_pid="$!"
  started=0
  for attempt in $(seq 1 40); do
    if [ -f "$ready" ]; then started=1; break; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  [ "$started" -eq 1 ] || { cat "$TMP/events.log" >&2; fail "LAN event receiver unavailable"; }
  ns "$APP2" python3 "$REPO_ROOT/scripts/remote-lan-lease-soak.py" client --duration 443 ||
    fail "443s bidirectional HA-like events interrupted"
  if [ "$REAL_FAULT" = 1 ]; then
    ! curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1 ||
      fail "Real RP API was unexpectedly reachable during event outage"
    : > "$TMP/fault-restore"
    if ! wait "$FAULT_PID"; then
      cat "$TMP/controlplane.log" >&2
      fail "API shutdown, real Traefik task churn or API restoration failed"
    fi
    cat "$TMP/controlplane.log"
    FAULT_PID=""
  fi
  [ "$(ns "$GATE" ip -o link show dev rp-gate | cut -d: -f1)" = "$wg_before" ] ||
    fail "WireGuard was recreated during bounded control-plane silence"
  [ "$(ns "$GATE" ip -o link show dev "$WAN2_DEV" | cut -d: -f1)" = "$gretap_before" ] ||
    fail "GRETAP was recreated during bounded control-plane silence"
  ns "$APP2" ping -q -c 2 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null ||
    fail "No IPv4 forwarding after 443s of control-plane silence"
  log "PASS uninterrupted 443s motion/click events, bidirectional encrypted L2, stable interfaces"

  # Keep the original Gate nft deadline. Neither API failure nor this test
  # may refresh the source before expiry; observe fail-closed after >600s.
  python3 - "$begin" <<'PY_WAIT_LEASE'
import sys,time
start=float(sys.argv[1])
time.sleep(max(0,608-(time.monotonic()-start)))
PY_WAIT_LEASE
  ns "$APP2" python3 "$REPO_ROOT/scripts/remote-lan-lease-soak.py" denied ||
    fail "Expired source still delivered HA-like events"
  if ns "$APP2" ping -q -c 1 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null 2>&1; then
    fail "Expired Gate nft source still forwards IPv4"
  fi
  log "PASS expiry stops IPv4 despite continued WireGuard/GRETAP availability"
  gate_source_policy "$SOURCE_BID" "192.168.90.24" "Active" "$(source_expiry 240)"
  ns "$APP2" ping -q -c 2 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null ||
    fail "Freshly reauthorized source did not recover"
  log "PASS recovery only after fresh source authorization"
  # Explicit policy withdrawal must immediately deny existing authorized
  # source packets even while WG/GRETAP remain up. Then a NEW approved
  # source install must recover without rebuilding the tunnel.
  gate_source_policy "$SOURCE_BID" "" "Revoked" ""
  if ns "$APP2" ping -q -c 1 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null 2>&1; then
    fail "Explicit Gate local source revocation did not deny IPv4"
  fi
  [ "$(ns "$GATE" ip -o link show dev rp-gate | cut -d: -f1)" = "$wg_before" ] ||
    fail "Explicit source revocation unnecessarily replaced WireGuard"
  gate_source_policy "$SOURCE_BID" "192.168.90.24" "Active" "$(source_expiry 240)"
  ns "$APP2" ping -q -c 2 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null ||
    fail "New authorized source did not restore connectivity after explicit revoke"
  log "PASS immediate local policy revoke and fresh reauthorization preserve WG/GRETAP identity"
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
fi

# Reuse the same encrypted WG/GRETAP application attachment to test Static
# address transition. The customer LAN supplies another on-link IP/gateway;
# RP tenant overlay's main default route must remain unchanged.
ns "$APP" ip route replace default via "$RP_IP" dev aa0
original_main="$(ns "$APP" ip -4 route show default)"
ns "$LAN" ip addr add 192.168.90.254/24 dev lan0
ns "$APP" ip -4 addr del 192.168.90.23/24 dev "$APP_DEV"
ns "$APP" busybox arping -D -f -c 3 -w 5 -I "$APP_DEV" 192.168.90.50 ||
  fail "static IPv4 duplicate detection failed on customer LAN"
ns "$APP" ip -4 addr add 192.168.90.50/24 dev "$APP_DEV"
gate_source_policy "$SOURCE_AID" "192.168.90.50" "Static" ""
ns "$APP" ip -4 route replace default via 192.168.90.254 dev "$APP_DEV" table 20015
ns "$APP" ip -4 rule add pref 18015 from 192.168.90.50/32 lookup 20015
[ "$(ns "$APP" ip -4 route show default)" = "$original_main" ] ||
  fail "static customer LAN rewrote Docker overlay default route"
ns "$APP" ip -4 route get 8.8.8.8 from 192.168.90.50 |
  grep -q 'via 192.168.90.254' ||
  fail "static application source rule does not use requested on-link gateway"
ns "$APP" ping -c 3 -W 2 -I 192.168.90.50 192.168.90.254 ||
  fail "static application cannot reach customer LAN through encrypted L2"
ns "$APP" ip -4 neigh show dev "$APP_DEV" | grep -q '192.168.90.254' ||
  fail "static app did not resolve its configured gateway through customer ARP"
ns "$APP" ip -4 rule del pref 18015
ns "$APP" ip -4 route flush table 20015
[ "$(ns "$APP" ip -4 route show default)" = "$original_main" ] ||
  fail "static revocation changed Docker overlay default"
log "PASS source-scoped Static IPv4 with custom gateway over encrypted L2"
ns "$GATE" ip link delete "$WAN_DEV"
if ns "$APP" ping -c 1 -W 2 -I "$APP_DEV" 192.168.90.1 >/dev/null 2>&1; then
  fail "revoked L2 tunnel still passes traffic"
fi
ns "$APP2" ping -c 2 -W 2 -I "$APP2_DEV" 192.168.90.1 ||
  fail "revoking the first attachment disrupted the independent second app"
# nft timed set must drop even the formerly valid IP when the validated
# lease expires, with no live controller heartbeat or reconciliation.
gate_source_policy "$SOURCE_BID" "192.168.90.24" "Active" "$(source_expiry 4)"
sleep 5
if ns "$APP2" ping -c 1 -W 1 -I "$APP2_DEV" 192.168.90.1 >/dev/null 2>&1; then
  fail "expired DHCP source authorization remained usable"
fi
log "PASS kernel lease timeout denies stale IPv4"
log "PASS per-app revocation leaves other customer's app tunnel connected"
ns "$GATE" ip link delete "$WAN2_DEV"
if ns "$APP2" ping -c 1 -W 2 -I "$APP2_DEV" 192.168.90.1 >/dev/null 2>&1; then
  fail "second revoked L2 tunnel still passes traffic"
fi
ns "$APP" ip link delete "$APP_DEV"
ns "$APP2" ip link delete "$APP2_DEV"
ns "$RP" ip link delete "$APP_DEV"
ns "$RP" ip link delete "$APP2_DEV"
ns "$RP" ip link delete "$WAN_DEV"
ns "$RP" ip link delete "$WAN2_DEV"
ns "$RP" ip link delete "$BRIDGE"
ns "$RP" ip link delete "$BRIDGE2"
ns "$GATE" ip link delete "$GATE_BRIDGE"
log "PASS independent multi-app L2 revocation"
