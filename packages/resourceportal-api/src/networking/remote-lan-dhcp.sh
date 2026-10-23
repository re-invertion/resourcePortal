#!/bin/sh
# BusyBox udhcpc runs this script inside the application network namespace.
# Preserve the Docker overlay default route and DNS settings.
set -eu
IFACE="${interface:-}"
case "$IFACE" in
  rp-a-????????) ;;
  *) echo "RP LAN DHCP: refusing non-RP interface" >&2; exit 1 ;;
esac
case "$1" in
  bound|renew)
    [ -n "${ip:-}" ] && [ -n "${subnet:-}" ] || exit 1
    prefix=0
    partial=0
    rest="$subnet"
    n=0
    while [ "$n" -lt 4 ]; do
      octet="${rest%%.*}"
      if [ "$rest" = "$octet" ]; then rest=""; else rest="${rest#*.}"; fi
      case "$octet" in
        255) bits=8 ;;
        254) bits=7 ;;
        252) bits=6 ;;
        248) bits=5 ;;
        240) bits=4 ;;
        224) bits=3 ;;
        192) bits=2 ;;
        128) bits=1 ;;
        0) bits=0 ;;
        *) echo "RP LAN DHCP: invalid subnet mask" >&2; exit 1 ;;
      esac
      [ "$partial" -eq 0 ] || [ "$bits" -eq 0 ] || exit 1
      prefix=$((prefix + bits))
      [ "$bits" -eq 8 ] || partial=1
      n=$((n + 1))
    done
    [ -z "$rest" ] || exit 1
    # DHCP is untrusted network input. An address/mask from another subnet
    # must not inject an on-link route into the application namespace.
    # The approved CIDR comes only from the authenticated node policy.
    expected="${RP_REMOTE_LAN_CIDR:-}"
    case "$expected" in
      */*) expected_prefix="${expected##*/}"; expected_network="${expected%/*}" ;;
      *) echo "RP LAN DHCP: missing authorized LAN CIDR" >&2; exit 1 ;;
    esac
    case "$expected_prefix" in
      1[6-9]|2[0-9]|30) ;;
      *) echo "RP LAN DHCP: invalid authorized LAN prefix" >&2; exit 1 ;;
    esac
    [ "$prefix" -eq "$expected_prefix" ] || {
      echo "RP LAN DHCP: DHCP mask differs from approved LAN" >&2; exit 1;
    }
    ipv4_number() {
      case "$1" in ""|*[!0-9.]*) return 1 ;; esac
      old_ifs="$IFS"
      IFS=.
      set -- $1
      IFS="$old_ifs"
      [ "$#" -eq 4 ] || return 1
      for octet in "$@"; do
        case "$octet" in
          0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9])
            [ "$octet" -le 255 ] || return 1 ;;
          *) return 1 ;;
        esac
      done
      IPV4_NUMBER=$(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 ))
    }
    ipv4_number "$expected_network" || exit 1
    network_number="$IPV4_NUMBER"
    ipv4_number "$ip" || exit 1
    lease_number="$IPV4_NUMBER"
    mask_number=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
    broadcast_number=$(( network_number | (0xffffffff ^ mask_number) ))
    [ $((network_number & mask_number)) -eq "$network_number" ] &&
    [ $((lease_number & mask_number)) -eq "$network_number" ] &&
    [ "$lease_number" -ne "$network_number" ] &&
    [ "$lease_number" -ne "$broadcast_number" ] || {
      echo "RP LAN DHCP: lease outside approved LAN or not a host" >&2; exit 1;
    }
    # Flush a previous lease before adding a new one. 'address replace'
    # does not necessarily remove a previous address with a different IP.
    # Never install DHCP-provided default routes or resolv.conf.
    ip -4 address flush dev "$IFACE" scope global
    ip -4 address add "$ip/$prefix" dev "$IFACE"
    ip link set dev "$IFACE" up
    ;;
  deconfig)
    ip -4 address flush dev "$IFACE" scope global
    ;;
  *) exit 0 ;;
esac
