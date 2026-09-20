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
    local ssh_server_port
    read -r _ _ _ ssh_server_port <<<"$SSH_CONNECTION"
    [[ "$ssh_server_port" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$ssh_server_port"
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
  printf 'allow from %s to any port 7443 proto tcp comment ResourcePortal-Enrollment\n' "$cluster_cidr"
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
  ufw allow from "$cluster_cidr" to any port 7443 proto tcp comment ResourcePortal-Enrollment
  if [[ "$ingress_enabled" == "true" ]]; then
    ufw allow 80/tcp comment ResourcePortal-HTTP
    ufw allow 443/tcp comment ResourcePortal-HTTPS
  fi
  ufw --force enable
  ufw reload
}

rp_ufw_resourceportal_ssh_port() {
  local status="$1"
  awk '
    /# ResourcePortal-SSH/ {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^[0-9]+\/tcp$/) {
          sub(/\/tcp$/, "", $i)
          print $i
          exit
        }
      }
    }
  ' <<<"$status"
}

rp_ufw_has_surviving_ssh_rule() {
  local status="$1" port="$2"
  awk -v target="${port}/tcp" '
    /# ResourcePortal-SSH/ { next }
    /ALLOW IN/ {
      for (i = 1; i <= NF; i++) {
        if ($i == target) { found = 1; exit }
      }
    }
    END { exit(found ? 0 : 1) }
  ' <<<"$status"
}

rp_remove_resourceportal_egress_firewall_rules() {
  local binary parent child parent_child
  for binary in iptables ip6tables; do
    command -v "$binary" >/dev/null 2>&1 || continue
    for parent_child in \
      'DOCKER-USER RP-TENANT-EGRESS' \
      'INPUT RP-TENANT-HOST'; do
      read -r parent child <<<"$parent_child"
      while "$binary" -w 5 -C "$parent" -j "$child" >/dev/null 2>&1; do
        "$binary" -w 5 -D "$parent" -j "$child" >/dev/null 2>&1 || return 1
      done
      if "$binary" -w 5 -S "$child" >/dev/null 2>&1; then
        "$binary" -w 5 -F "$child" >/dev/null 2>&1 || return 1
        "$binary" -w 5 -X "$child" >/dev/null 2>&1 || return 1
      fi
    done
  done
}

rp_remove_resourceportal_ufw_rules() {
  local status cleanup_status number port retain_installer_ssh=false
  command -v ufw >/dev/null 2>&1 || return 0
  status="$(ufw status numbered 2>/dev/null || true)"
  cleanup_status="$status"

  if [[ "$status" == *'Status: active'* && "$status" == *'# ResourcePortal-SSH'* ]]; then
    port="$(rp_ufw_resourceportal_ssh_port "$status")" || return 1
    [[ "$port" =~ ^[0-9]+$ ]] || {
      printf '%s\n' 'Refusing ResourcePortal UFW cleanup because the installer SSH allow rule port could not be determined safely.' >&2
      return 1
    }
    if ! rp_ufw_has_surviving_ssh_rule "$status" "$port"; then
      retain_installer_ssh=true
    fi
  fi

  if [[ "$retain_installer_ssh" == true ]]; then
    # Keep the only working SSH allow in place. Adding an equivalent UFW rule
    # with a different comment is not safe: UFW may deduplicate it, after
    # which deleting the installer rule would lock out new SSH connections.
    cleanup_status="$(grep -v -F '# ResourcePortal-SSH' <<<"$status" || true)"
  fi

  while IFS= read -r number; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    ufw --force delete "$number" >/dev/null || return 1
  done < <(
    grep -F '# ResourcePortal-' <<<"$cleanup_status" \
      | sed -nE 's/^\[[[:space:]]*([0-9]+)\].*# ResourcePortal-.*/\1/p' \
      | sort -rn
  )
}
