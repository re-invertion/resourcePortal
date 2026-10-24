#!/usr/bin/env bash
# Disposable four-namespace Ethernet-over-WireGuard DHCP integration smoke.
set -euo pipefail
export PATH="/usr/sbin:/sbin:$PATH"
APP="rpa-$$"; RP="rpr-$$"; GATE="rpg-$$"; LAN="rpl-$$"
TMP="$(mktemp -d)"
MAC="02:aa:bb:cc:dd:ee"
APP_IP="10.200.42.12"; RP_IP="10.200.42.20"
SV_IP="100.96.90.1"; CL_IP="100.96.90.2"
log() { printf '[l2-dhcp] %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ns() { local net="$1"; shift; sudo -n ip netns exec "$net" "$@"; }
cleanup() {
  set +e
  for net in "$APP" "$RP" "$GATE" "$LAN"; do
    sudo -n ip netns pids "$net" 2>/dev/null | xargs -r sudo -n kill >/dev/null 2>&1 || true
    sudo -n ip netns del "$net" >/dev/null 2>&1 || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
for binary in ip wg dnsmasq busybox python3 ping; do
  command -v "$binary" >/dev/null || fail "missing $binary"
done
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s "$REPO_ROOT/test" -p "test_gate*py" -v
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
for net in "$APP" "$RP" "$GATE" "$LAN"; do
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
ns "$RP" wg set wg0 private-key "$TMP/s.key" listen-port 55051 \
  peer "$(cat "$TMP/c.pub")" allowed-ips "$CL_IP/32" endpoint 172.31.90.2:55052
ns "$GATE" wg set rp-gate private-key "$TMP/c.key" listen-port 55052 \
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
ns "$GATE" ip link add "$GATE_BRIDGE" type bridge stp_state 1
ns "$GATE" ip link set "$WAN_DEV" master "$GATE_BRIDGE"
ns "$GATE" ip link set eth1 master "$GATE_BRIDGE"
ns "$GATE" ip link set "$GATE_BRIDGE" up
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
  for pair in "$RP:$APP_DEV" "$RP:$WAN_DEV" "$GATE:$WAN_DEV" "$GATE:eth1"; do
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
  --port=0 --dhcp-range=192.168.90.20,192.168.90.40,255.255.255.0,5m \
  --dhcp-authoritative --dhcp-host="$MAC,192.168.90.23" \
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
ns "$APP" ping -c 3 -W 2 -I "$APP_DEV" 192.168.90.1 ||
  fail "application cannot reach remote LAN"
ns "$APP" ip -4 neigh show dev "$APP_DEV" | grep -q "192.168.90.1" ||
  fail "application did not learn remote LAN ARP"
log "PASS Ethernet ARP and LAN IP"

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
ns "$APP" ip link delete "$APP_DEV"
ns "$RP" ip link delete "$APP_DEV"
ns "$RP" ip link delete "$WAN_DEV"
ns "$RP" ip link delete "$BRIDGE"
ns "$GATE" ip link delete "$GATE_BRIDGE"
log "PASS L2 revocation"
