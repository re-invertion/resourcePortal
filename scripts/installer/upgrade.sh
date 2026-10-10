#!/usr/bin/env bash

rp_upgrade_rollback_allowed() {
  local manifest="$1" policy
  rp_validate_release_manifest "$manifest" || return 1
  policy="$(rp_manifest_value "$manifest" '.migrations.rollbackPolicy')" || return 1
  case "$policy" in image-only|tested) ;; *) return 1 ;; esac
  # New manifests attest compatibility with the immediately preceding
  # release only. Do not automatically roll back an older source even if the
  # manifest advertises other supported *upgrade* source versions.
  local assessment_source source_version
  assessment_source="$(jq -r '.migrations.rollbackAssessment.sourceVersion // empty' "$manifest")" || return 1
  if [[ -n "$assessment_source" ]]; then
    source_version="${RP_UPGRADE_SOURCE_VERSION:-${RP_CFG_RELEASE_VERSION:-}}"
    [[ -n "$source_version" && "$source_version" == "$assessment_source" ]] || return 1
  fi
  return 0
}

rp_upgrade_check_temporary_files() {
  # The updater runs in Alpine (BusyBox mktemp), not the host's GNU coreutils.
  # Fail before quiescing API/Worker/ZITADEL when /tmp cannot create files.
  local probe
  probe="$(mktemp /tmp/resourceportal-upgrade-preflight.XXXXXX)" || {
    printf 'Upgrade preflight: cannot create a temporary file in /tmp.\n' >&2
    return 1
  }
  rm -f -- "$probe"
}

rp_upgrade_preflight() {
  local manifest="$1" installer_version="$2" current_version="$3" docker_version="$4"
  rp_release_compatible "$manifest" "$installer_version" "$current_version" "$docker_version" || return 1
  rp_upgrade_check_temporary_files
}

rp_pull_release_images() {
  local manifest="$1" image
  rp_validate_release_manifest "$manifest" || return 1
  while IFS= read -r image; do
    # Release manifests use immutable digests. If Docker already has the exact
    # digest locally, pulling it again adds no integrity and can fail solely
    # because an upstream registry rate-limits an otherwise safe upgrade.
    if docker image inspect "$image" >/dev/null 2>&1; then
      continue
    fi
    docker pull "$image" >/dev/null || return 1
  done < <(jq -r '.images | [.api,.web,.postgres,.zitadel,.traefik][]' "$manifest")
}

rp_upgrade_label_value() {
  local node="$1" label="$2"
  docker node inspect "$node" --format "{{ index .Spec.Labels \"$label\" }}" 2>/dev/null || return 1
}

rp_upgrade_add_label_if_missing() {
  local node="$1" label="$2" value="$3" current
  current="$(rp_upgrade_label_value "$node" "$label")" || return 1
  case "$current" in
    true|false) return 0 ;;
  esac
  docker node update --label-add "${label}=${value}" "$node" >/dev/null || return 1
}

rp_upgrade_ensure_v020_node_labels() {
  local target_version="$1" node oldest legacy tenant storage_capability label value
  oldest="$(printf '%s\n%s\n' '0.2.0' "$target_version" | sort -V | head -n1)"
  [[ "$oldest" == '0.2.0' ]] || return 0

  while IFS= read -r node; do
    [[ -n "$node" ]] || continue

    tenant="$(rp_upgrade_label_value "$node" 'resourceportal.tenant-workloads')" || return 1
    case "$tenant" in
      true|false)
        rp_upgrade_add_label_if_missing "$node" 'rp.node.tenant-workloads' "$tenant" || return 1
        ;;
      *)
        docker node update \
          --label-add resourceportal.tenant-workloads=true \
          --label-add rp.node.tenant-workloads=true \
          "$node" >/dev/null || return 1
        ;;
    esac

    for legacy in resourceportal.control-plane resourceportal.ingress; do
      value="$(rp_upgrade_label_value "$node" "$legacy")" || return 1
      [[ "$value" == true ]] || continue
      case "$legacy" in
        resourceportal.control-plane) label='rp.node.control-plane' ;;
        resourceportal.ingress) label='rp.node.ingress' ;;
      esac
      rp_upgrade_add_label_if_missing "$node" "$label" true || return 1
    done

    storage_capability=false
    for legacy in \
      resourceportal.storage.authoritative \
      resourceportal.storage.volumes \
      resourceportal.storage.secrets \
      resourceportal.storage.platform; do
      value="$(rp_upgrade_label_value "$node" "$legacy")" || return 1
      if [[ "$value" == true ]]; then
        storage_capability=true
        break
      fi
    done
    if [[ "$storage_capability" == true ]]; then
      rp_upgrade_add_label_if_missing "$node" 'rp.node.storage' true || return 1
    fi
  done < <(docker node ls -q)
}

rp_upgrade_wait_service_image() {
  local service_name="$1" expected_image="$2" timeout="${3:-300}"
  local elapsed=0 running current_image

  while (( elapsed < timeout )); do
    current_image="$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
    running="$(docker service ps --filter desired-state=running --format '{{.CurrentState}}' "$service_name" 2>/dev/null | awk '$1 == "Running" { count++ } END { print count + 0 }')"
    if [[ "$current_image" == "$expected_image" && "$running" == 1 ]]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service ps --no-trunc "$service_name" >&2 || true
  return 1
}

rp_upgrade_update_service_image() {
  local service_name="$1" image="$2" description="$3"
  local timeout="${RP_UPGRADE_SERVICE_TIMEOUT_SECONDS:-300}" current_image

  current_image="$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null)" || return 1
  if [[ "$current_image" == "$image" ]]; then
    return 0
  fi

  printf 'Updating %s: %s\n' "$description" "$image" >&2
  docker service update --detach=false --image "$image" --with-registry-auth "$service_name" >/dev/null || return 1
  rp_upgrade_wait_service_image "$service_name" "$image" "$timeout" || {
    printf '%s did not converge after image update.\n' "$description" >&2
    return 1
  }
}

rp_upgrade_set_service_replicas() {
  local service_name="$1" replicas="$2" description="${3:-$1}" mode
  docker service inspect "$service_name" >/dev/null 2>&1 || return 0
  mode="$(docker service inspect "$service_name" --format '{{if .Spec.Mode.Replicated}}replicated{{else}}other{{end}}')" || return 1
  [[ "$mode" == replicated ]] || {
    printf 'Cannot scale non-replicated upgrade dependency: %s\n' "$description" >&2
    return 1
  }
  printf 'Scaling %s to %s replica(s) for database-safe upgrade.\n' "$description" "$replicas" >&2
  docker service update --detach=false --replicas "$replicas" "$service_name" >/dev/null || return 1
}

rp_upgrade_quiesce_database_clients() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}" service service_name
  for service in api worker dr-reconciliation zitadel; do
    service_name="${stack_name}_${service}"
    rp_upgrade_set_service_replicas "$service_name" 0 "$service" || return 1
  done
  for service_name in "${stack_name}_egress-guard" "${stack_name}-installer-enrollment"; do
    if docker service inspect "$service_name" >/dev/null 2>&1; then
      printf 'Removing transient database client for upgrade: %s\n' "$service_name" >&2
      docker service rm "$service_name" >/dev/null || return 1
    fi
  done
}

rp_upgrade_prepare_postgres_services() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local target_image="${RP_CFG_POSTGRES_IMAGE:-}" service

  rp_validate_image_ref "$target_image" || {
    printf 'Target PostgreSQL image must be pinned by sha256 digest before upgrade rollout.\n' >&2
    return 1
  }

  # Pre-roll the databases before the final stack deploy. This keeps the API,
  # Worker and ZITADEL rollout from racing a simultaneous PostgreSQL restart.
  for service in postgres-rp postgres-zitadel; do
    rp_upgrade_update_service_image \
      "${stack_name}_${service}" \
      "$target_image" \
      "${service} database" || return 1
  done
}

rp_upgrade_zitadel_migration_bridge_image() {
  # v4.15.1 records migration 64_change_push_position against
  # eventstore.command[] before v4.17 introduces eventstore.command2 in
  # migration 70. Keep the tested bridge immutable.
  printf '%s\n' 'ghcr.io/zitadel/zitadel@sha256:0d88e6e92d0bd98641c107a054715ca57cbd68ca2119d3600cfe95aa6ccc7be4'
}

rp_upgrade_requires_zitadel_migration_bridge() {
  local current_version="$1"
  ! rp_version_ge "$current_version" '0.2.12'
}

rp_upgrade_wait_zitadel_image() {
  local service_name="$1" expected_image="$2" timeout="$3"
  local elapsed=0 running current_image

  while (( elapsed < timeout )); do
    current_image="$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
    running="$(docker service ps --filter desired-state=running --format '{{.CurrentState}}' "$service_name" 2>/dev/null | awk '$1 == "Running" { count++ } END { print count + 0 }')"
    if [[ "$current_image" == "$expected_image" && "$running" == 1 ]]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service ps --no-trunc "$service_name" >&2 || true
  return 1
}

rp_upgrade_update_zitadel_image() {
  local service_name="$1" image="$2" description="$3"
  local timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}"

  printf 'Updating ZITADEL for %s: %s\n' "$description" "$image" >&2
  docker service update --detach=false --image "$image" --with-registry-auth "$service_name" >/dev/null || return 1
  rp_upgrade_wait_zitadel_image "$service_name" "$image" "$timeout" || {
    printf 'ZITADEL service did not converge during %s.\n' "$description" >&2
    return 1
  }
}

rp_upgrade_prepare_zitadel_for_mcp_oauth() {
  local source_version="${1:-${RP_CFG_RELEASE_VERSION:-0.0.0}}"
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name="${stack_name}_zitadel"
  local target_image="${RP_CFG_ZITADEL_IMAGE:-}" current_image bridge_image

  rp_validate_image_ref "$target_image" || {
    printf 'Target ZITADEL image must be pinned by sha256 digest before MCP OAuth reconciliation.\n' >&2
    return 1
  }
  docker service inspect "$service_name" >/dev/null 2>&1 || {
    printf 'ZITADEL service is unavailable for upgrade reconciliation: %s\n' "$service_name" >&2
    return 1
  }
  rp_upgrade_set_service_replicas "$service_name" 1 'ZITADEL' || return 1

  current_image="$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')" || return 1
  if [[ "$current_image" == "$target_image" ]]; then
    return 0
  fi

  if rp_upgrade_requires_zitadel_migration_bridge "$source_version"; then
    bridge_image="$(rp_upgrade_zitadel_migration_bridge_image)" || return 1
    rp_validate_image_ref "$bridge_image" || return 1
    if [[ "$current_image" != "$bridge_image" ]]; then
      docker pull "$bridge_image" >/dev/null || return 1
      rp_upgrade_update_zitadel_image "$service_name" "$bridge_image" 'legacy migration bridge' || return 1
      current_image="$bridge_image"
    fi
  fi

  if [[ "$current_image" != "$target_image" ]]; then
    rp_upgrade_update_zitadel_image "$service_name" "$target_image" 'target release' || return 1
  fi
}

rp_upgrade_refresh_firewall() {
  local ssh_port
  if [[ "${RP_UPGRADE_SKIP_HOST_FIREWALL:-false}" == true ]]; then
    return 0
  fi
  # resourceportal-install.sh sources firewall.sh before upgrade dispatch.
  # Keep isolated unit sourcing safe while making real upgrades fail closed.
  if ! declare -F rp_detect_ssh_port >/dev/null || ! declare -F rp_configure_ufw >/dev/null; then
    return 0
  fi
  ssh_port="$(rp_detect_ssh_port)" || {
    printf 'Unable to determine SSH port while refreshing ResourcePortal firewall rules.\n' >&2
    return 1
  }
  rp_configure_ufw "$ssh_port" "${RP_CFG_CLUSTER_CIDR:?RP_CFG_CLUSTER_CIDR is required}" true
}

rp_upgrade_refresh_enrollment_listener() {
  # resourceportal-install.sh sources lifecycle.sh after upgrade.sh, so the
  # primary enrollment helper is available by the time upgrade dispatch runs.
  # Keep this a no-op for isolated unit sourcing of upgrade.sh.
  if declare -F rp_primary_start_enrollment >/dev/null; then
    rp_primary_start_enrollment
  fi
}

# Upgrade journal lives on the persisted installer volume (also mounted in
# the updater container). An interrupted update is *never* resumed blindly:
# an operator must verify schema/runtime state and reconcile the checkpoint.
rp_upgrade_checkpoint_copy() {
  local source="$1" destination="$2" tmp
  [[ -r "$source" && ! -L "$source" ]] || return 1
  tmp="$(mktemp "${destination%/*}/.checkpoint.XXXXXX")" || return 1
  if ! cp -- "$source" "$tmp" || ! chmod 0600 "$tmp" || ! mv -f -- "$tmp" "$destination"; then
    rm -f -- "$tmp"
    return 1
  fi
}

rp_upgrade_checkpoint_verify() {
  local dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" expected observed
  [[ -n "$dir" && -r "$dir/state.json" ]] || return 1
  expected="$(jq -er '.previousStackSha256' "$dir/state.json")" || return 1
  observed="$(sha256sum "$dir/previous-stack.yml" | cut -d' ' -f1)" || return 1
  [[ "$expected" == "$observed" ]] || {
    printf 'Checkpoint integrity failure: previous stack has changed. Manual recovery required.\n' >&2
    return 1
  }
}

rp_upgrade_checkpoint_restore_file() {
  local source="$1" target="$2" exists="$3" tmp
  if [[ "$exists" == true ]]; then
    [[ -r "$source" ]] || return 1
    install -d -m 0700 "${target%/*}" || return 1
    tmp="$(mktemp "${target%/*}/.rollback.XXXXXX")" || return 1
    if ! cp -- "$source" "$tmp" || ! chmod 0600 "$tmp" || ! mv -f -- "$tmp" "$target"; then
      rm -f -- "$tmp"
      return 1
    fi
  else
    rm -f -- "$target" || return 1
  fi
}

rp_upgrade_checkpoint_prepare() {
  local manifest="$1" previous_stack="$2" source_version="$3"
  local dir="${RP_UPGRADE_STATE_DIR:-${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/upgrade}" tmp prior
  local config_file="${RP_UPGRADE_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"
  local stack_file="${RP_UPGRADE_STACK_FILE:-/etc/resourceportal/stack.yml}"
  local config_exists=false manifest_exists=false
  [[ "$dir" == /* && -r "$manifest" && -r "$previous_stack" ]] || return 1
  command -v flock >/dev/null 2>&1 || {
    printf 'Upgrade lock support (flock) is required.\n' >&2
    return 1
  }
  install -d -m 0700 "$dir" || return 1
  [[ ! -L "$dir" ]] || return 1
  exec {RP_UPGRADE_LOCK_FD}>"$dir/lock" || return 1
  if ! flock -n "$RP_UPGRADE_LOCK_FD"; then
    printf 'Another ResourcePortal upgrade is already active.\n' >&2
    return 1
  fi
  if [[ -e "$dir/state.json" ]]; then
    prior="$(jq -r '.phase // "unknown"' "$dir/state.json" 2>/dev/null || printf 'invalid')"
    case "$prior" in
      completed|rolled-back) ;;
      *)
        printf 'Unresolved previous upgrade checkpoint (%s). Manual recovery required before retry.\n' "$prior" >&2
        return 1
        ;;
    esac
  fi
  rp_upgrade_checkpoint_copy "$previous_stack" "$dir/previous-stack.yml" || return 1
  if [[ -e "$config_file" ]]; then
    rp_upgrade_checkpoint_copy "$config_file" "$dir/previous-installer.conf" || return 1
    config_exists=true
  else
    rm -f "$dir/previous-installer.conf" || return 1
  fi
  if [[ -e "$stack_file" ]]; then
    rp_upgrade_checkpoint_copy "$stack_file" "$dir/previous-installed-stack.yml" || return 1
  else
    # The supplied previous stack is authoritative when the installed copy
    # does not exist, but never guess where an old stack could have lived.
    rp_upgrade_checkpoint_copy "$previous_stack" "$dir/previous-installed-stack.yml" || return 1
  fi
  # Preserve the previous manifest so a failure after manifest persistence
  # cannot leave state.json pointing at a failed target release.
  local installed_manifest="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/release.json"
  if [[ -r "$installed_manifest" ]]; then
    rp_upgrade_checkpoint_copy "$installed_manifest" "$dir/previous-release.json" || return 1
    manifest_exists=true
  else
    rm -f "$dir/previous-release.json"
  fi
  tmp="$(mktemp "$dir/.state.XXXXXX")" || return 1
  jq -n --arg source "$source_version" \
    --arg target "$(rp_manifest_value "$manifest" '.version')" \
    --arg stackSha256 "$(sha256sum "$dir/previous-stack.yml" | cut -d' ' -f1)" \
    --arg manifestSha256 "$(sha256sum "$manifest" | cut -d' ' -f1)" \
    --argjson configExists "$config_exists" --argjson manifestExists "$manifest_exists" \
    '{phase:"prepared", sourceVersion:$source, targetVersion:$target, previousStackSha256:$stackSha256, targetManifestSha256:$manifestSha256, configExists:$configExists, manifestExists:$manifestExists}' >"$tmp" &&
    chmod 0600 "$tmp" && mv -f "$tmp" "$dir/state.json" || { rm -f "$tmp"; return 1; }
  RP_UPGRADE_ACTIVE_CHECKPOINT="$dir"
  export RP_UPGRADE_ACTIVE_CHECKPOINT
}

rp_upgrade_checkpoint_phase() {
  local phase="$1" step="${2:-}" dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" tmp
  [[ -n "$dir" ]] || return 0
  [[ -r "$dir/state.json" ]] || return 1
  tmp="$(mktemp "$dir/.state.XXXXXX")" || return 1
  if ! jq --arg phase "$phase" --arg step "$step" \
    '.phase=$phase | .lastStep=$step' "$dir/state.json" > "$tmp" ||
    ! chmod 0600 "$tmp" || ! mv -f "$tmp" "$dir/state.json"; then
    rm -f "$tmp"
    return 1
  fi
  # Allow a new attempt in the current shell only after a terminal,
  # verified outcome. Incomplete updates keep the lock until process exit.
  case "$phase" in
    completed|rolled-back)
      if [[ -n "${RP_UPGRADE_LOCK_FD:-}" ]]; then
        flock -u "$RP_UPGRADE_LOCK_FD" || return 1
        exec {RP_UPGRADE_LOCK_FD}>&-
        unset RP_UPGRADE_LOCK_FD
      fi
      ;;
  esac
}

rp_upgrade_restore_manifest_checkpoint() {
  local dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" manifest_file
  local config_file="${RP_UPGRADE_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"
  local stack_file="${RP_UPGRADE_STACK_FILE:-/etc/resourceportal/stack.yml}"
  local state_file config_exists manifest_exists
  [[ -n "$dir" ]] || return 0
  state_file="$dir/state.json"
  rp_upgrade_checkpoint_verify || return 1
  config_exists="$(jq -r '.configExists | if type == "boolean" then . else error("invalid") end' "$state_file")" || return 1
  manifest_exists="$(jq -r '.manifestExists | if type == "boolean" then . else error("invalid") end' "$state_file")" || return 1
  manifest_file="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/release.json"
  rp_upgrade_checkpoint_restore_file "$dir/previous-release.json" "$manifest_file" "$manifest_exists" || return 1
  rp_upgrade_checkpoint_restore_file "$dir/previous-installer.conf" "$config_file" "$config_exists" || return 1
  rp_upgrade_checkpoint_restore_file "$dir/previous-installed-stack.yml" "$stack_file" true || return 1
}

rp_upgrade_restore_after_failure() {
  local manifest="$1" previous_stack="$2" failed_step="$3"
  printf "ResourcePortal update failed at %s.\n" "$failed_step" >&2
  if ! rp_upgrade_rollback_allowed "$manifest"; then
    rp_upgrade_checkpoint_phase manual-recovery-required "$failed_step" || true
    printf "Automatic rollback refused: release manifest does not authorize safe rollback from this source version. Manual recovery may be required.\n" >&2
    return 1
  fi
  rp_upgrade_checkpoint_phase rolling-back "$failed_step" || return 1
  local rollback_stack="$previous_stack"
  if [[ -n "${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" ]]; then
    rp_upgrade_checkpoint_verify || {
      rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
      return 1
    }
    rollback_stack="$RP_UPGRADE_ACTIVE_CHECKPOINT/previous-stack.yml"
  fi
  printf "Automatically restoring the previous ResourcePortal stack...\n" >&2
  if ! docker stack deploy --compose-file "$rollback_stack" --with-registry-auth --prune "${RP_CFG_STACK_NAME:-resourceportal-control-plane}"; then
    rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
    printf "Automatic rollback failed: previous stack could not be deployed.\n" >&2
    return 1
  fi
  if ! rp_wait_for_https_origin "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300; then
    rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
    printf "Automatic rollback deployed previous stack, but health verification failed.\n" >&2
    return 1
  fi
  rp_upgrade_restore_manifest_checkpoint || {
    rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
    return 1
  }
  rp_upgrade_checkpoint_phase rolled-back "$failed_step" || return 1
  printf "Automatic rollback completed: previous ResourcePortal stack is healthy. Update failed.\n" >&2
  return 1
}

rp_upgrade_apply() {
  local manifest="$1" previous_stack="$2" canonical_manifest
  local source_version="${RP_CFG_RELEASE_VERSION:-0.0.0}"
  RP_UPGRADE_SOURCE_VERSION="$source_version"
  export RP_UPGRADE_SOURCE_VERSION
  [[ -r "$previous_stack" ]] || return 1
  # Keep this guard even when the apply function is invoked directly.
  rp_upgrade_check_temporary_files || return 1
  rp_config_apply_defaults || return 1
  rp_pull_release_images "$manifest" || return 1
  rp_apply_release_manifest_images "$manifest" || return 1
  rp_upgrade_checkpoint_prepare "$manifest" "$previous_stack" "$source_version" || return 1
  rp_upgrade_checkpoint_phase applying "before-mutating-runtime" || return 1
  rp_upgrade_ensure_v020_node_labels "$(rp_manifest_value "$manifest" '.version')" || {
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "node-role reconcile"; return 1;
  }
  rp_upgrade_refresh_firewall || {
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "host firewall refresh"; return 1;
  }
  rp_upgrade_quiesce_database_clients || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "database quiesce"; return 1; }
  rp_upgrade_prepare_postgres_services || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "PostgreSQL preparation"; return 1; }
  rp_upgrade_prepare_zitadel_for_mcp_oauth "$source_version" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "ZITADEL preparation"; return 1; }
  rp_run_zitadel_mcp_oauth_reconcile || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "MCP OAuth reconciliation"; return 1; }
  if [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == staging ]]; then
    declare -F rp_prepare_oidc_staging_ca >/dev/null || return 1
    rp_prepare_oidc_staging_ca "${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "OIDC staging CA"; return 1; }
  fi
  if ! rp_run_migrations || ! rp_deploy_control_plane final || ! rp_wait_for_https_origin "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300; then
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "migration/deployment health"
    return 1
  fi
  if ! rp_upgrade_refresh_enrollment_listener; then
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "enrollment listener"
    return 1
  fi
  canonical_manifest="$(rp_persist_release_manifest "$manifest")" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "manifest persistence"; return 1; }
  RP_CFG_RELEASE_VERSION="$(rp_manifest_value "$canonical_manifest" '.version')"
  RP_CFG_RELEASE_MANIFEST="$canonical_manifest"
  export RP_CFG_RELEASE_VERSION RP_CFG_RELEASE_MANIFEST
  rp_config_write /etc/resourceportal/installer.conf || {
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "installer configuration persistence"
    return 1
  }
  rp_write_stack final /etc/resourceportal/stack.yml || {
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "stack file persistence"
    return 1
  }
  rp_upgrade_checkpoint_phase completed "target-stack-healthy" || return 1
}
