#!/usr/bin/env bash

rp_detect_os_text() {
  local text="$1"
  local id="" version=""
  while IFS='=' read -r key value; do
    value="${value%\"}"
    value="${value#\"}"
    case "$key" in
      ID) id="$value" ;;
      VERSION_ID) version="$value" ;;
    esac
  done <<<"$text"
  printf '%s:%s\n' "$id" "$version"
}

rp_detect_os() {
  [[ -r /etc/os-release ]] || return 1
  rp_detect_os_text "$(cat /etc/os-release)"
}

rp_os_supported() {
  local id="$1" version="$2"
  case "$id:$version" in
    debian:12|debian:13|ubuntu:24.04|ubuntu:26.04) return 0 ;;
    *) return 1 ;;
  esac
}

rp_require_root_uid() {
  [[ "$1" == "0" ]]
}

rp_require_root() {
  rp_require_root_uid "$(id -u)" || {
    printf 'ResourcePortal installer must run as root.\n' >&2
    return 1
  }
}

rp_preflight_system() {
  local detected id version
  rp_require_root || return 1
  detected="$(rp_detect_os)" || return 1
  id="${detected%%:*}"
  version="${detected#*:}"
  if ! rp_os_supported "$id" "$version"; then
    printf 'Unsupported operating system: %s %s\n' "$id" "$version" >&2
    return 1
  fi
  printf '%s %s\n' "$id" "$version"
}
