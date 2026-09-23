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

rp_upgrade_prepare_zitadel_for_mcp_oauth() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name="${stack_name}_zitadel"
  local target_image="${RP_CFG_ZITADEL_IMAGE:-}" current_image
  local timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}" elapsed=0 running

  rp_validate_image_ref "$target_image" || {
    printf 'Target ZITADEL image must be pinned by sha256 digest before MCP OAuth reconciliation.\n' >&2
    return 1
  }
  docker service inspect "$service_name" >/dev/null 2>&1 || {
    printf 'ZITADEL service is unavailable for upgrade reconciliation: %s\n' "$service_name" >&2
    return 1
  }
  current_image="$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')" || return 1
  if [[ "$current_image" != "$target_image" ]]; then
    docker service update --image "$target_image" --with-registry-auth "$service_name" >/dev/null || return 1
  fi

  while (( elapsed < timeout )); do
    running="$(docker service ps --filter desired-state=running --format '{{.CurrentState}}' "$service_name" 2>/dev/null | awk '$1 == "Running" { count++ } END { print count + 0 }')"
    if [[ "$running" == 1 ]]; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service ps --no-trunc "$service_name" >&2 || true
  printf 'ZITADEL service did not converge to the target image before MCP OAuth reconciliation.\n' >&2
  return 1
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
  local manifest="$1" previous_stack="$2"
  [[ -r "$previous_stack" ]] || return 1
  rp_config_apply_defaults || return 1
  rp_pull_release_images "$manifest" || return 1
  rp_apply_release_manifest_images "$manifest" || return 1
  rp_upgrade_ensure_v020_node_labels "$(rp_manifest_value "$manifest" '.version')" || return 1
  rp_upgrade_prepare_zitadel_for_mcp_oauth || return 1
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
  RP_CFG_RELEASE_VERSION="$(rp_manifest_value "$manifest" '.version')"
  RP_CFG_RELEASE_MANIFEST="$manifest"
  export RP_CFG_RELEASE_VERSION RP_CFG_RELEASE_MANIFEST
  rp_config_write /etc/resourceportal/installer.conf
  rp_write_stack final /etc/resourceportal/stack.yml
}
