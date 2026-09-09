#!/usr/bin/env bash

rp_docker_version_supported() {
  local installed="$1" minimum="$2"
  rp_version_ge "$installed" "$minimum"
}

rp_docker_command_present() {
  command -v docker >/dev/null 2>&1
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
  local id version codename arch repo
  local keyring="${RP_DOCKER_APT_KEY:-/etc/apt/keyrings/docker.asc}"
  local source_path="${RP_DOCKER_APT_SOURCE:-/etc/apt/sources.list.d/docker.list}"
  local had_key=false had_source=false
  [[ -e "$keyring" ]] && had_key=true
  [[ -e "$source_path" ]] && had_source=true

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

  apt-get update || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg || return 1
  install -m 0755 -d "$(dirname "$keyring")" "$(dirname "$source_path")" || return 1
  curl -fsSL "https://download.docker.com/linux/$id/gpg" -o "$keyring" || return 1
  chmod a+r "$keyring" || return 1
  arch="$(dpkg --print-architecture)" || return 1
  repo="deb [arch=$arch signed-by=$keyring] https://download.docker.com/linux/$id $codename stable"
  printf '%s\n' "$repo" >"$source_path" || return 1
  apt-get update || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
  systemctl enable --now docker || return 1

  rp_ownership_record docker installed-by-resourceportal || return 1
  [[ "$had_key" == true ]] || rp_ownership_record apt-key "$keyring" || return 1
  [[ "$had_source" == true ]] || rp_ownership_record apt-source "$source_path" || return 1
}

rp_ensure_docker() {
  local minimum="$1"
  if rp_docker_command_present; then
    rp_validate_docker "$minimum"
    return
  fi
  rp_install_docker
  rp_validate_docker "$minimum"
}

rp_docker_package_names() {
  printf '%s\n' docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

rp_docker_apt_key_path() {
  printf '%s\n' "${RP_DOCKER_APT_KEY:-/etc/apt/keyrings/docker.asc}"
}

rp_docker_apt_source_path() {
  printf '%s\n' "${RP_DOCKER_APT_SOURCE:-/etc/apt/sources.list.d/docker.list}"
}
