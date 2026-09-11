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

rp_preserve_ssh_before_resourceportal_ufw_cleanup() {
  local status="$1" port
  [[ "$status" == *'Status: active'* ]] || return 0
  [[ "$status" == *'# ResourcePortal-SSH'* ]] || return 0
  port="$(rp_ufw_resourceportal_ssh_port "$status")" || return 1
  [[ "$port" =~ ^[0-9]+$ ]] || {
    printf '%s\n' 'Refusing ResourcePortal UFW cleanup because the installer SSH allow rule port could not be determined safely.' >&2
    return 1
  }
  rp_ufw_has_surviving_ssh_rule "$status" "$port" && return 0

  # Factory reset previously removed the only SSH allow while UFW remained
  # active, immediately locking the operator out before later cleanup phases.
  # Install a non-ResourcePortal safety rule first so RP-only cleanup cannot
  # delete the connection that is executing the reset. The rule is naturally
  # removed if UFW itself is an installer-owned package and is later purged.
  ufw allow "$port/tcp" comment Preserved-SSH-after-RP-removal >/dev/null || return 1
}

rp_remove_resourceportal_ufw_rules() {
  local status number
  command -v ufw >/dev/null 2>&1 || return 0
  status="$(ufw status numbered 2>/dev/null || true)"
  rp_preserve_ssh_before_resourceportal_ufw_cleanup "$status" || return 1
  while IFS= read -r number; do
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    ufw --force delete "$number" >/dev/null || return 1
  done < <(
    grep -F '# ResourcePortal-' <<<"$status" \
      | sed -nE 's/^\[[[:space:]]*([0-9]+)\].*# ResourcePortal-.*/\1/p' \
      | sort -rn
  )
}
