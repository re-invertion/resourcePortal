#!/usr/bin/env bash

rp_upgrade_rollback_allowed() {
  local manifest="$1" policy
  rp_validate_release_manifest "$manifest" || return 1
  policy="$(rp_manifest_value "$manifest" '.migrations.rollbackPolicy')" || return 1
  case "$policy" in image-only|tested) return 0 ;; *) return 1 ;; esac
}

rp_upgrade_preflight() {
  local manifest="$1" installer_version="$2" current_version="$3" docker_version="$4"
  rp_release_compatible "$manifest" "$installer_version" "$current_version" "$docker_version"
}

rp_pull_release_images() {
  local manifest="$1" image
  rp_validate_release_manifest "$manifest" || return 1
  while IFS= read -r image; do docker pull "$image" >/dev/null || return 1; done \
    < <(jq -r '.images | [.api,.web,.postgres,.zitadel,.traefik][]' "$manifest")
}

rp_upgrade_apply() {
  local manifest="$1" previous_stack="$2"
  [[ -r "$previous_stack" ]] || return 1
  rp_pull_release_images "$manifest" || return 1
  rp_apply_release_manifest_images "$manifest" || return 1
  if ! rp_run_migrations || ! rp_deploy_control_plane final; then
    if rp_upgrade_rollback_allowed "$manifest"; then
      docker stack deploy --compose-file "$previous_stack" --with-registry-auth "${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
      return 1
    fi
    printf 'Upgrade failed after an irreversible/incompatible migration. Automatic rollback refused.\n' >&2
    return 1
  fi
}
