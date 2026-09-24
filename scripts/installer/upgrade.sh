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

rp_upgrade_refresh_enrollment_listener() {
  # resourceportal-install.sh sources lifecycle.sh after upgrade.sh, so the
  # primary enrollment helper is available by the time upgrade dispatch runs.
  # Keep this a no-op for isolated unit sourcing of upgrade.sh.
  if declare -F rp_primary_start_enrollment >/dev/null; then
    rp_primary_start_enrollment
  fi
}

rp_upgrade_apply() {
  local manifest="$1" previous_stack="$2" canonical_manifest
  local source_version="${RP_CFG_RELEASE_VERSION:-0.0.0}"
  [[ -r "$previous_stack" ]] || return 1
  rp_config_apply_defaults || return 1
  rp_pull_release_images "$manifest" || return 1
  rp_apply_release_manifest_images "$manifest" || return 1
  rp_upgrade_ensure_v020_node_labels "$(rp_manifest_value "$manifest" '.version')" || return 1
  rp_upgrade_quiesce_database_clients || return 1
  rp_upgrade_prepare_postgres_services || return 1
  rp_upgrade_prepare_zitadel_for_mcp_oauth "$source_version" || return 1
  rp_run_zitadel_mcp_oauth_reconcile || return 1
  if [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == staging ]]; then
    declare -F rp_prepare_oidc_staging_ca >/dev/null || return 1
    rp_prepare_oidc_staging_ca "${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" || return 1
  fi
  if ! rp_run_migrations || ! rp_deploy_control_plane final || ! rp_wait_for_https_origin "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300; then
    if rp_upgrade_rollback_allowed "$manifest"; then
      docker stack deploy --compose-file "$previous_stack" --with-registry-auth --prune "${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
      return 1
    fi
    printf 'Upgrade failed after an irreversible/incompatible migration. Automatic rollback refused.\n' >&2
    return 1
  fi
  if ! rp_upgrade_refresh_enrollment_listener; then
    printf 'Upgrade core services are healthy, but the enrollment listener could not be refreshed to the target release.\n' >&2
    return 1
  fi
  canonical_manifest="$(rp_persist_release_manifest "$manifest")" || return 1
  RP_CFG_RELEASE_VERSION="$(rp_manifest_value "$canonical_manifest" '.version')"
  RP_CFG_RELEASE_MANIFEST="$canonical_manifest"
  export RP_CFG_RELEASE_VERSION RP_CFG_RELEASE_MANIFEST
  rp_config_write /etc/resourceportal/installer.conf
  rp_write_stack final /etc/resourceportal/stack.yml
}
