#!/usr/bin/env bash

rp_detect_ssh_port() {
  local port
  port="$(ss -ltnp 2>/dev/null | awk '
    /sshd/ {
      addr=$4;
      sub(/^.*:/, "", addr);
      if (addr ~ /^[0-9]+$/) { print addr; exit }
    }
  ')"
  if [[ -n "$port" ]]; then
    printf '%s\n' "$port"
    return 0
  fi
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    set -- $SSH_CONNECTION
    [[ "${4:-}" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$4"
    return 0
  fi
  return 1
}

rp_render_ufw_rules() {
  local ssh_port="$1" cluster_cidr="$2" ingress_enabled="$3"
  [[ "$ssh_port" =~ ^[0-9]+$ ]] || return 1
  [[ -n "$cluster_cidr" ]] || return 1

  printf 'allow %s/tcp comment ResourcePortal-SSH\n' "$ssh_port"
  printf 'allow from %s to any port 2377 proto tcp comment ResourcePortal-Swarm-Manager\n' "$cluster_cidr"
  printf 'allow from %s to any port 7946 proto tcp comment ResourcePortal-Swarm-Gossip-TCP\n' "$cluster_cidr"
  printf 'allow from %s to any port 7946 proto udp comment ResourcePortal-Swarm-Gossip-UDP\n' "$cluster_cidr"
  printf 'allow from %s to any port 4789 proto udp comment ResourcePortal-Swarm-Overlay\n' "$cluster_cidr"
  printf 'allow from %s to any port 2049 proto tcp comment ResourcePortal-NFSv4\n' "$cluster_cidr"
  if [[ "$ingress_enabled" == "true" ]]; then
    printf 'allow 80/tcp comment ResourcePortal-HTTP\n'
    printf 'allow 443/tcp comment ResourcePortal-HTTPS\n'
  fi
}

rp_configure_ufw() {
  local ssh_port="$1" cluster_cidr="$2" ingress_enabled="$3"
  command -v ufw >/dev/null 2>&1 || {
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ufw
  }

  # Preserve SSH before any firewall activation or reload.
  ufw allow "$ssh_port/tcp" comment ResourcePortal-SSH
  ufw allow from "$cluster_cidr" to any port 2377 proto tcp comment ResourcePortal-Swarm-Manager
  ufw allow from "$cluster_cidr" to any port 7946 proto tcp comment ResourcePortal-Swarm-Gossip-TCP
  ufw allow from "$cluster_cidr" to any port 7946 proto udp comment ResourcePortal-Swarm-Gossip-UDP
  ufw allow from "$cluster_cidr" to any port 4789 proto udp comment ResourcePortal-Swarm-Overlay
  ufw allow from "$cluster_cidr" to any port 2049 proto tcp comment ResourcePortal-NFSv4
  if [[ "$ingress_enabled" == "true" ]]; then
    ufw allow 80/tcp comment ResourcePortal-HTTP
    ufw allow 443/tcp comment ResourcePortal-HTTPS
  fi
  ufw --force enable
  ufw reload
}
