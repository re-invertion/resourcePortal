#!/usr/bin/env bash

RP_INSTALLER_LOG_FILE="${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}"

rp_log_init() {
  install -d -m 0750 "$(dirname "$RP_INSTALLER_LOG_FILE")"
  touch "$RP_INSTALLER_LOG_FILE"
  chmod 0600 "$RP_INSTALLER_LOG_FILE"
}

rp_log() {
  local level="$1" line
  shift
  line="$(printf '%s [%s] %s' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$level" "$*")"
  printf '%s\n' "$line" >&2
  if [[ -n "${RP_INSTALLER_LOG_FILE:-}" && -w "${RP_INSTALLER_LOG_FILE:-}" ]]; then
    printf '%s\n' "$line" >>"$RP_INSTALLER_LOG_FILE"
  fi
}

rp_die() {
  rp_log ERROR "$*"
  return 1
}

rp_version_ge() {
  local current="$1" required="$2"
  local c_major=0 c_minor=0 c_patch=0 r_major=0 r_minor=0 r_patch=0
  IFS=. read -r c_major c_minor c_patch <<<"$current"
  IFS=. read -r r_major r_minor r_patch <<<"$required"
  c_major=${c_major:-0}; c_minor=${c_minor:-0}; c_patch=${c_patch:-0}
  r_major=${r_major:-0}; r_minor=${r_minor:-0}; r_patch=${r_patch:-0}

  (( 10#$c_major > 10#$r_major )) && return 0
  (( 10#$c_major < 10#$r_major )) && return 1
  (( 10#$c_minor > 10#$r_minor )) && return 0
  (( 10#$c_minor < 10#$r_minor )) && return 1
  (( 10#$c_patch >= 10#$r_patch ))
}
