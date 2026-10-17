#!/usr/bin/env bash

rp_upgrade_rollback_allowed() {
  local manifest="$1" policy
  rp_validate_release_manifest "$manifest" || return 1
  policy="$(rp_manifest_value "$manifest" '.migrations.rollbackPolicy')" || return 1
  case "$policy" in image-only|tested) ;; *) return 1 ;; esac
  if [[ "$policy" == tested ]]; then
    jq -e '.migrations.rollbackEvidence.databaseSnapshotRestored == true and
      .migrations.rollbackEvidence.restoredSourceSchema == true and
      .migrations.rollbackEvidence.zitadelDatabaseRestored == true and
      .migrations.rollbackEvidence.zitadelSourceRuntimeReadyAfterRollback == true and
      .migrations.rollbackEvidence.zitadelSourceEventstoreVerified == true and
      .migrations.rollbackEvidence.candidateZitadelRuntimeReadyBeforeRollback == true' "$manifest" >/dev/null || return 1
  fi
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

# For schema-changing releases, the *real installer* takes permission-restricted
# logical snapshots of BOTH databases before any migration or ZITADEL write. The same
# functions are exercised against disposable PostgreSQL instances in release CI.
# A compatibility probe of the previous Prisma client is NOT database restore.
rp_upgrade_database_task() {
  local role="$1" service="${RP_CFG_STACK_NAME:-resourceportal-control-plane}_$1" id
  local -a ids=()
  [[ "$role" == postgres-rp || "$role" == postgres-zitadel ]] || return 1
  mapfile -t ids < <(docker ps --no-trunc -q --filter "label=com.docker.swarm.service.name=$service")
  [[ "${#ids[@]}" == 1 ]] || {
    printf 'Database rollback refused: %s must have exactly one local task.\n' "$service" >&2
    return 1
  }
  id="${ids[0]}"
  [[ "$(docker inspect "$id" --format '{{.State.Health.Status}}' 2>/dev/null)" == healthy ]] || {
    printf 'Database rollback refused: %s local task is not healthy.\n' "$service" >&2
    return 1
  }
  printf '%s\n' "$id"
}

rp_upgrade_database_snapshot_prepare() {
  local dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" manifest="$1" policy backup role id tmp
  policy="$(rp_manifest_value "$manifest" '.migrations.rollbackPolicy')" || return 1
  [[ "$policy" == tested ]] || return 0
  [[ -n "$dir" && -r "$dir/state.json" && ! -L "$dir" ]] || return 1
  # Unique per-attempt path: a previous completed upgrade may still have its
  # own sealed audit snapshot in the same persistent checkpoint directory.
  backup="$(umask 077; mktemp -d "$dir/database-snapshots.XXXXXX")" || return 1
  [[ -d "$backup" && ! -L "$backup" ]] || return 1
  for role in postgres-rp postgres-zitadel; do
    id="$(rp_upgrade_database_task "$role")" || return 1
    tmp="$backup/$role.dump"
    # Dump through the local PostgreSQL service identity. A failed/partial dump
    # must never become authoritative rollback evidence.
    if ! (umask 077; docker exec --user postgres "$id" sh -ec \
      'exec pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$tmp"); then
      printf 'Database rollback refused: %s source dump failed.\n' "$role" >&2
      return 1
    fi
    [[ -s "$tmp" ]] || return 1
    docker exec -i --user postgres "$id" pg_restore --list < "$tmp" >/dev/null || return 1
    # pg_dump archives do not restore database ownership when replayed into
    # a newly created shadow DB. Preserve the real RP/ZITADEL database owner
    # with the signed snapshot so source ZITADEL init retains CREATE rights.
    local db_owner
    db_owner="$(docker exec --user postgres "$id" sh -ec '
      exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 \
        -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()"
    ')" || return 1
    [[ "$db_owner" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 1
    printf '%s\n' "$db_owner" >"$backup/$role.owner" || return 1
  done
  (cd "$backup" && sha256sum postgres-rp.dump postgres-zitadel.dump postgres-rp.owner postgres-zitadel.owner > SHA256SUMS &&
    sha256sum -c SHA256SUMS >/dev/null) || return 1
  # Journal marker is written atomically only AFTER two complete verified dumps.
  tmp="$(mktemp "$dir/.database-checkpoint.XXXXXX")" || return 1
  if ! jq --arg backup "${backup##*/}" \
    '.databaseSnapshotState="verified" | .databaseSnapshotDirectory=$backup' "$dir/state.json" > "$tmp" ||
     ! chmod 0600 "$tmp" || ! mv -f "$tmp" "$dir/state.json"; then
    rm -f "$tmp"; return 1
  fi
  return 0
}

rp_upgrade_database_restore() {
  local dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" state backup role id tmp
  [[ -n "$dir" && -r "$dir/state.json" && ! -L "$dir" ]] || return 1
  state="$(jq -er '.databaseSnapshotState // "none"' "$dir/state.json")" || return 1
  [[ "$state" == verified || "$state" == restored || "$state" == none ]] || return 1
  [[ "$state" == none ]] && return 0
  # A prior, fully verified restore is idempotent; do not replay a data restore
  # from an older checkpoint after the database resumes serving requests.
  [[ "$state" == restored ]] && return 0
  local backup_name
  backup_name="$(jq -er '.databaseSnapshotDirectory' "$dir/state.json")" || return 1
  [[ "$backup_name" =~ ^database-snapshots\.[A-Za-z0-9]{6}$ ]] || return 1
  backup="$dir/$backup_name"
  [[ -d "$backup" && ! -L "$backup" && -f "$backup/SHA256SUMS" && ! -L "$backup/SHA256SUMS" ]] || return 1
  (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null) || return 1
  # Stop every database writer before restoring, including after a target stack
  # has been deployed and the previous quiesce state has been lost.
  rp_upgrade_quiesce_database_clients || return 1
  for role in postgres-rp postgres-zitadel; do
    id="$(rp_upgrade_database_task "$role")" || return 1
    [[ -s "$backup/$role.dump" && ! -L "$backup/$role.dump" ]] || return 1
    # A normal pg_restore --clean only drops objects present in the SOURCE
    # archive. Candidate-only tables would survive and poison the next upgrade.
    # Instead, restore the entire source archive into a freshly created shadow
    # DB first; switch database names only after pg_restore fully commits.
    local staging failed_db
    staging="rp_restore_$(date -u +%s)_${RANDOM}"
    failed_db="${staging}_failed"
    [[ "$staging" =~ ^[a-z0-9_]+$ && "$failed_db" =~ ^[a-z0-9_]+$ ]] || return 1
    docker exec --user postgres --env "RP_RESTORE_STAGE=$staging" "$id" sh -ec '
      createdb -U "$POSTGRES_USER" -T template0 "$RP_RESTORE_STAGE"
    ' || return 1
    # Restore original Zitadel eventstore ownership. An unconditional
    # --no-owner would reassign all zitadel_user objects to postgres.
    local restore_no_owner=""
    [[ "$role" == postgres-zitadel ]] || restore_no_owner="--no-owner"
    if ! docker exec -i --user postgres --env "RP_RESTORE_STAGE=$staging" \
      --env "RP_RESTORE_NO_OWNER=$restore_no_owner" "$id" sh -ec '
      if [ -n "$RP_RESTORE_NO_OWNER" ]; then
        exec pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
          -U "$POSTGRES_USER" -d "$RP_RESTORE_STAGE"
      fi
      exec pg_restore --exit-on-error --single-transaction \
        -U "$POSTGRES_USER" -d "$RP_RESTORE_STAGE"
    ' < "$backup/$role.dump"; then
      printf 'Database staging restore FAILED (%s); candidate DB preserved for recovery.\n' "$role" >&2
      return 1
    fi
    local restored_db_owner
    restored_db_owner="$(cat "$backup/$role.owner")" || return 1
    [[ "$restored_db_owner" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || return 1
    docker exec --user postgres --env "RP_RESTORE_STAGE=$staging" \
      --env "RP_RESTORE_OWNER=$restored_db_owner" "$id" sh -ec '
      exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
        -c "ALTER DATABASE \"$RP_RESTORE_STAGE\" OWNER TO \"$RP_RESTORE_OWNER\""
    ' || return 1
    # No application clients are running. Disconnect any stale external
    # connections, then quarantine the mutated database rather than deleting
    # it. Should a rename fail, do not redeploy old API: manual recovery is
    # required and both original and restored databases remain on disk.
    if ! docker exec --user postgres \
      --env "RP_RESTORE_STAGE=$staging" --env "RP_RESTORE_QUARANTINE=$failed_db" \
      "$id" sh -ec '
        case "$POSTGRES_DB:$RP_RESTORE_STAGE:$RP_RESTORE_QUARANTINE" in
          *[!a-zA-Z0-9_:]*|:*|*::*) exit 1 ;;
        esac
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
          -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();" >/dev/null
        psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
          -c "ALTER DATABASE \"$POSTGRES_DB\" RENAME TO \"$RP_RESTORE_QUARANTINE\"" >/dev/null
        psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
          -c "ALTER DATABASE \"$RP_RESTORE_STAGE\" RENAME TO \"$POSTGRES_DB\"" >/dev/null
      '; then
      printf 'Database swap FAILED (%s); manual recovery required.\n' "$role" >&2
      return 1
    fi
  done
  tmp="$(mktemp "$dir/.database-checkpoint.XXXXXX")" || return 1
  if ! jq '.databaseSnapshotState="restored"' "$dir/state.json" > "$tmp" ||
     ! chmod 0600 "$tmp" || ! mv -f "$tmp" "$dir/state.json"; then
    rm -f "$tmp"; return 1
  fi
}

# The installer must not complete while only /api/health/live works and
# tenant OIDC is still migrating or blocked. Query the target API via the
# trusted local ingress with the same TLS policy as ordinary readiness.
rp_upgrade_validate_tenant_oidc_ready() {
  local domain="$1" local_ingress="${RP_HTTPS_LOCAL_INGRESS_ADDRESS:-127.0.0.1}"
  local -a args=(--fail --silent --show-error --proto '=https' --tlsv1.2
    --connect-timeout 10 --max-time 20 --resolve "${domain}:443:${local_ingress}")
  if [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == staging ]]; then
    args+=(--insecure)
  fi
  curl "${args[@]}" "https://${domain}/api/health/tenant-oidc" >/dev/null 2>&1
}

rp_upgrade_wait_for_tenant_oidc_ready() {
  local domain="$1" timeout="${2:-300}" elapsed=0
  [[ "$timeout" =~ ^[0-9]+$ && "$timeout" -ge 5 ]] || return 1
  while (( elapsed < timeout )); do
    if rp_upgrade_validate_tenant_oidc_ready "$domain"; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  printf 'Upgrade blocked: tenant OIDC activation did not become ready within %ss. Previous stack will be restored.\n' "$timeout" >&2
  return 1
}

rp_upgrade_check_temporary_files() {
  # The updater runs in Alpine (BusyBox mktemp), not the host's GNU coreutils.
  # Fail before quiescing API/Worker/ZITADEL when /tmp cannot create files.
  local probe state_dir
  probe="$(mktemp /tmp/resourceportal-upgrade-preflight.XXXXXX)" || {
    printf 'Upgrade preflight: mktemp failed in /tmp.\n' >&2
    return 1
  }
  rm -f -- "$probe"
  # Check the checkpoint directory BEFORE stopping API/Worker/ZITADEL; a
  # successful /tmp probe alone does not prove this writable volume is usable.
  state_dir="${RP_UPGRADE_STATE_DIR:-${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/upgrade}"
  if [[ "$state_dir" != /* || -L "$state_dir" ]] || ! install -d -m 0700 "$state_dir"; then
    printf 'Upgrade preflight: invalid or unavailable checkpoint directory.\n' >&2
    return 1
  fi
  probe="$(mktemp "$state_dir/.rp-preflight.XXXXXX")" || {
    printf 'Upgrade preflight: mktemp failed in checkpoint directory.\n' >&2
    return 1
  }
  rm -f -- "$probe"
}

rp_upgrade_preflight() {
  local manifest="$1" installer_version="$2" current_version="$3" docker_version="$4"
  rp_release_compatible "$manifest" "$installer_version" "$current_version" "$docker_version" || return 1
  rp_verify_release_manifest_attestation "$manifest" || return 1
  rp_upgrade_rollback_allowed "$manifest" || {
    printf 'Upgrade blocked: automatic rollback for this source release is not verified.\n' >&2
    return 1
  }
  rp_upgrade_identity_preflight || return 1
  rp_upgrade_check_temporary_files
}

# Validate everything the target OAuth bootstrap needs before quiescing clients.
# Inspect only secret references; never export key material into argv or logs.
rp_upgrade_identity_preflight() {
  local pat="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"
  if ! declare -F rp_zitadel_management_state_ready >/dev/null || ! rp_zitadel_management_state_ready; then
    printf 'Upgrade identity preflight: organization/project/management metadata is unavailable.\n' >&2
    return 1
  fi
  [[ -s "$pat" && -r "$pat" ]] || {
    printf 'Upgrade identity preflight: management PAT file is missing or empty.\n' >&2; return 1;
  }
  [[ -n "${RP_CFG_ZITADEL_DOMAIN:-}" ]] || {
    printf 'Upgrade identity preflight: ZITADEL instance hostname is missing.\n' >&2; return 1;
  }
  docker secret inspect rp_encryption_key >/dev/null 2>&1 || {
    printf 'Upgrade identity preflight: rp_encryption_key Swarm secret is unavailable.\n' >&2; return 1;
  }
}

rp_upgrade_checkpoint_stage() {
  local stage="$1" dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" tmp
  [[ -n "$dir" ]] || return 0
  tmp="$(mktemp "$dir/.stage.XXXXXX")" || return 1
  jq --arg stage "$stage" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.runtimeStage=$stage | .updatedAt=$at' "$dir/state.json" >"$tmp" &&
    chmod 0600 "$tmp" && mv -f "$tmp" "$dir/state.json" || { rm -f "$tmp"; return 1; }
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
    '.phase=$phase | .lastStep=$step | .errorCode=(if $phase == "manual-recovery-required" or $phase == "rollback-failed" then "UpgradeStepFailed" else null end)' "$dir/state.json" > "$tmp" ||
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
  # A corrupted/missing snapshot marker is NEVER interpreted as image-only
  # rollback after database mutations began. Before the postgres stage it is
  # safe to restore only the stack, because no database has been changed yet.
  local claim snapshot_stage
  claim="$(rp_manifest_value "$manifest" '.migrations.rollbackPolicy')" || return 1
  if [[ "$claim" == tested ]]; then
    snapshot_stage="$(jq -er '.databaseSnapshotState // "none"' "$RP_UPGRADE_ACTIVE_CHECKPOINT/state.json")" || return 1
    if [[ "$snapshot_stage" == none ]]; then
      local runtime_stage
      runtime_stage="$(jq -r '.runtimeStage // "before-mutating-runtime"' "$RP_UPGRADE_ACTIVE_CHECKPOINT/state.json")" || return 1
      case "$runtime_stage" in
        before-mutating-runtime|quiescing-clients|database-snapshot) ;;
        *)
          rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
          printf 'Automatic rollback blocked: required database snapshot evidence is missing after mutation.\n' >&2
          return 1 ;;
      esac
    fi
  fi
  # Do not start previous API/ZITADEL against a mutated database. Restore both
  # source snapshots first; an incomplete restore MUST NOT become rolled-back.
  if ! rp_upgrade_database_restore; then
    rp_upgrade_checkpoint_phase rollback-failed "$failed_step" || true
    printf 'Automatic rollback cannot restore the source databases; leave services quiesced for recovery.\n' >&2
    return 1
  fi
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
  rp_verify_release_manifest_attestation "$manifest" || return 1
  rp_upgrade_rollback_allowed "$manifest" || {
    printf 'Upgrade blocked: release manifest does not guarantee automatic rollback.\n' >&2
    return 1
  }
  rp_upgrade_identity_preflight || return 1
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
  rp_upgrade_checkpoint_stage quiescing-clients || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint quiescing-clients"; return 1; }
  rp_upgrade_quiesce_database_clients || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "database quiesce"; return 1; }
  rp_upgrade_checkpoint_stage database-snapshot || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint database-snapshot"; return 1; }
  rp_upgrade_database_snapshot_prepare "$manifest" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "database snapshot"; return 1; }
  rp_upgrade_checkpoint_stage postgres-rollout || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint postgres-rollout"; return 1; }
  rp_upgrade_prepare_postgres_services || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "PostgreSQL preparation"; return 1; }
  rp_upgrade_checkpoint_stage zitadel-rollout || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint zitadel-rollout"; return 1; }
  rp_upgrade_prepare_zitadel_for_mcp_oauth "$source_version" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "ZITADEL preparation"; return 1; }
  rp_upgrade_checkpoint_stage mcp-oauth-reconciliation || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint mcp-oauth-reconciliation"; return 1; }
  rp_run_zitadel_mcp_oauth_reconcile || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "MCP OAuth reconciliation"; return 1; }
  if [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == staging ]]; then
    declare -F rp_prepare_oidc_staging_ca >/dev/null || return 1
    rp_prepare_oidc_staging_ca "${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "OIDC staging CA"; return 1; }
  fi
  rp_upgrade_checkpoint_stage resourceportal-migrations-started || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint resourceportal-migrations-started"; return 1; }
  if ! rp_run_migrations || ! rp_deploy_control_plane final || ! rp_wait_for_https_origin "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300; then
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "migration/deployment health"
    return 1
  fi
  rp_upgrade_checkpoint_stage tenant-oidc-activation || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint tenant-oidc-activation"; return 1; }
  if ! rp_upgrade_wait_for_tenant_oidc_ready "${RP_CFG_DOMAIN:?RP_CFG_DOMAIN is required}" 300; then
    rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "tenant OIDC activation"
    return 1
  fi
  rp_upgrade_checkpoint_stage target-stack-healthy || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint target-stack-healthy"; return 1; }
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
  rp_upgrade_checkpoint_phase completed "target-stack-healthy" || { rp_upgrade_restore_after_failure "$manifest" "$previous_stack" "checkpoint completed"; return 1; }
}
