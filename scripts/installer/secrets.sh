#!/usr/bin/env bash

rp_secret_exists() {
  docker secret inspect "$1" >/dev/null 2>&1
}

rp_ensure_swarm_secret() {
  local name="$1" source_file="$2"
  [[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "$source_file" == /* && -r "$source_file" ]] || return 1
  if rp_secret_exists "$name"; then
    return 0
  fi
  # Read from stdin so secret content never appears in process arguments.
  docker secret create "$name" - <"$source_file" >/dev/null
}

rp_generate_secret_file() {
  local target="$1" bytes="${2:-32}"
  [[ "$target" == /* && "$bytes" =~ ^[0-9]+$ && "$bytes" -ge 16 ]] || return 1
  umask 077
  mkdir -p "$(dirname "$target")"
  openssl rand -base64 "$bytes" | tr -d '\n' >"$target"
  chmod 0600 "$target"
}

rp_remove_secret_file() {
  local path="$1"
  [[ "$path" == /* ]] || return 1
  if command -v shred >/dev/null 2>&1; then
    shred -u "$path" 2>/dev/null || rm -f "$path"
  else
    rm -f "$path"
  fi
}

rp_versioned_secret_name() {
  local logical_name="$1" source_file="$2" digest
  [[ "$logical_name" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "$source_file" == /* && -r "$source_file" ]] || return 1
  digest="$(sha256sum "$source_file" | awk '{print substr($1,1,16)}')" || return 1
  [[ "$digest" =~ ^[a-fA-F0-9]{16}$ ]] || return 1
  printf '%s_%s\n' "$logical_name" "$digest"
}

rp_ensure_versioned_swarm_secret() {
  local logical_name="$1" source_file="$2" versioned_name
  versioned_name="$(rp_versioned_secret_name "$logical_name" "$source_file")" || return 1
  if ! rp_secret_exists "$versioned_name"; then
    docker secret create "$versioned_name" - <"$source_file" >/dev/null || return 1
  fi
  printf '%s\n' "$versioned_name"
}
