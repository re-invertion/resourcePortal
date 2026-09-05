#!/usr/bin/env bash

rp_docker_version_supported() {
  local installed="$1" minimum="$2"
  rp_version_ge "$installed" "$minimum"
}

rp_validate_docker() {
  local minimum="$1" version swarm_state
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || return 1
  rp_docker_version_supported "$version" "$minimum" || {
    printf 'Installed Docker %s is older than required %s. Refusing automatic replacement.\n' "$version" "$minimum" >&2
    return 1
  }
  swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" || return 1
  case "$swarm_state" in
    active|inactive|pending|locked|error) ;;
    *) return 1 ;;
  esac
}

rp_install_docker() {
  local id version codename arch keyring repo
  # shellcheck disable=SC1091
  source /etc/os-release
  id="$ID"
  version="$VERSION_ID"
  codename="${VERSION_CODENAME:-}"
  case "$id:$version" in
    debian:12|debian:13|ubuntu:24.04|ubuntu:26.04) ;;
    *) printf 'Unsupported OS for Docker installation: %s %s\n' "$id" "$version" >&2; return 1 ;;
  esac
  [[ -n "$codename" ]] || return 1

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  keyring=/etc/apt/keyrings/docker.asc
  curl -fsSL "https://download.docker.com/linux/$id/gpg" -o "$keyring"
  chmod a+r "$keyring"
  arch="$(dpkg --print-architecture)"
  repo="deb [arch=$arch signed-by=$keyring] https://download.docker.com/linux/$id $codename stable"
  printf '%s\n' "$repo" >/etc/apt/sources.list.d/docker.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

rp_ensure_docker() {
  local minimum="$1"
  if command -v docker >/dev/null 2>&1; then
    rp_validate_docker "$minimum"
    return
  fi
  rp_install_docker
  rp_validate_docker "$minimum"
}
