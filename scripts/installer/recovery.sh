#!/usr/bin/env bash
# Deliberately narrow recovery authorization for the recorded 0.2.78 -> 0.2.81
# OAuth failure. This is not a generic checkpoint-reset or downgrade API.
rp_recovery_verify_checkpoint() {
  if ! (
    set -e
    local dir="$1" target="$2" installed="$3" config="$4" stack="$5" file
    for file in "$dir/state.json" "$dir/previous-stack.yml" "$dir/previous-installed-stack.yml" \
      "$dir/previous-installer.conf" "$dir/previous-release.json" "$target" "$installed" "$config" "$stack"; do
      [[ -f "$file" && -r "$file" && ! -L "$file" ]] || exit 1
    done
    jq -e '.phase == "manual-recovery-required" and .sourceVersion == "0.2.78" and
      .targetVersion == "0.2.81" and .lastStep == "MCP OAuth reconciliation" and
      .configExists == true and .manifestExists == true and
      (.runtimeStage == null or .runtimeStage == "mcp-oauth-reconciliation")' "$dir/state.json" >/dev/null || exit 1
    [[ "$(jq -er '.version' "$target")" == 0.2.81 ]] || exit 1
    [[ "$(jq -er '.version' "$installed")" == 0.2.78 ]] || exit 1
    [[ "$(sha256sum "$dir/previous-stack.yml" | cut -d' ' -f1)" == "$(jq -er '.previousStackSha256' "$dir/state.json")" ]] || exit 1
    [[ "$(sha256sum "$target" | cut -d' ' -f1)" == "$(jq -er '.targetManifestSha256' "$dir/state.json")" ]] || exit 1
    cmp -s "$dir/previous-release.json" "$installed" || exit 1
    cmp -s "$dir/previous-installer.conf" "$config" || exit 1
    cmp -s "$dir/previous-installed-stack.yml" "$stack" || exit 1
  ); then
    printf 'Recovery refused: checkpoint, source files or target manifest do not match the verified pre-migration OAuth failure.\n' >&2
    return 1
  fi
}

rp_recovery_archive_checkpoint() {
  local dir="$1" backup="$2"
  [[ -r "$backup/SHA256SUMS" && -s "$backup/resourceportal.dump" && -s "$backup/zitadel.dump" && -s "$backup/host-state.tar.gz" ]] || {
    printf 'Recovery refused: complete verified backup is required before journal archival.\n' >&2; return 1;
  }
  (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null) || return 1
  [[ ! -e "$backup/original-checkpoint" && -r "$dir/state.json" ]] || return 1
  # Preserve evidence while retaining the active unresolved guard. Only the
  # target adapter may take ownership atomically under the shared journal lock.
  cp -a "$dir" "$backup/original-checkpoint" || return 1
  cmp -s "$dir/state.json" "$backup/original-checkpoint/state.json" || return 1

}

# Recovery-only adapter, appended to the verified target installer library.
# It retains the authoritative source snapshots and consumes one exact failed
# journal; generic installer checkpoint preparation remains fail-closed.
rp_recovery_prepare_checkpoint() {
  local manifest="$1" previous_stack="$2" source_version="$3"
  local dir="${RP_UPGRADE_STATE_DIR:-${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/upgrade}"
  local backup="${RP_RECOVERY_BACKUP:-}" expected="${RP_RECOVERY_CHECKPOINT_SHA256:-}" tmp
  [[ "$source_version" == 0.2.78 && "$expected" =~ ^[a-f0-9]{64}$ && "$dir" == /* && ! -L "$dir" ]] || return 1
  [[ "$backup" == /* && -r "$backup/original-checkpoint/state.json" ]] || return 1
  exec {RP_UPGRADE_LOCK_FD}>"$dir/lock" || return 1
  flock -n "$RP_UPGRADE_LOCK_FD" || return 1
  [[ "$(sha256sum "$dir/state.json" | cut -d' ' -f1)" == "$expected" ]] || return 1
  cmp -s "$dir/state.json" "$backup/original-checkpoint/state.json" || return 1
  (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null) || return 1
  rp_recovery_verify_checkpoint "$dir" "$manifest"     "${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/release.json"     "${RP_UPGRADE_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"     "${RP_UPGRADE_STACK_FILE:-/etc/resourceportal/stack.yml}" || return 1
  tmp="$(mktemp "$dir/.recovery.XXXXXX")" || return 1
  jq --arg original "$expected" --arg backup "$backup"     '.phase="prepared" | .lastStep="recovery checkpoint takeover" |
     .recovery={originalCheckpointSha256:$original,backup:$backup} |
     .runtimeStage="recovery-prepared"' "$dir/state.json" > "$tmp" &&
    chmod 0600 "$tmp" && mv -f "$tmp" "$dir/state.json" || { rm -f "$tmp"; return 1; }
  RP_UPGRADE_ACTIVE_CHECKPOINT="$dir"
  export RP_UPGRADE_ACTIVE_CHECKPOINT
}
