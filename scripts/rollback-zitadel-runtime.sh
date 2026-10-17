#!/usr/bin/env bash
# CI-only published/candidate ZITADEL startup verification on disposable DBs.
rp_rollback_zitadel_prepare() {
  [[ "${GITHUB_ACTIONS:-}" == true && "${RP_ROLLBACK_E2E_ISOLATED:-}" == true ]] || {
    echo "Refusing ZITADEL rollback test outside isolated GitHub CI" >&2
    return 1
  }
  [[ "${RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE:-}" =~ ^ghcr\.io/zitadel/zitadel:v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "Candidate ZITADEL image must be an explicitly selected release tag" >&2
    return 1
  }
  docker pull "$RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE" >/dev/null || return 1
  candidate_zitadel="$(docker image inspect --format '{{index .RepoDigests 0}}' "$RP_ROLLBACK_CANDIDATE_ZITADEL_IMAGE")" || return 1
  rp_release_image_ref_valid "$candidate_zitadel" &&
    rp_release_image_repo_allowed "$candidate_zitadel" zitadel || return 1
  zitadel_runtime_container="${stack}-zitadel-runtime"
  local config_dir="$root/zitadel-real-runtime"
  install -d -m 0700 "$config_dir" "$config_dir/bootstrap" || return 1
  cat >"$config_dir/public.yaml" <<'YAML'
Log:
  Level: warn
Port: 8080
ExternalDomain: localhost
ExternalPort: 18080
ExternalSecure: false
TLS:
  Enabled: false
DefaultInstance:
  Features:
    LoginV2:
      Required: false
Database:
  postgres:
    Host: zitadel-db
    Port: 5432
    Database: zitadel
    User:
      SSL:
        Mode: disable
    Admin:
      SSL:
        Mode: disable
YAML
  cat >"$config_dir/secrets.yaml" <<'YAML'
Database:
  postgres:
    User:
      Username: zitadel_user
      Password: rollback-smoke-only
    Admin:
      Username: postgres
      Password: rollback-smoke-only
YAML
  cat >"$config_dir/steps.yaml" <<'YAML'
FirstInstance:
  PatPath: /bootstrap/admin.pat
  Org:
    Human:
      Username: rollback-admin
      Password: RollbackTestOnlyPass!123
      PasswordChangeRequired: false
    Machine:
      Machine:
        Username: rollback-bootstrap
        Name: Isolated Rollback Bootstrap
      Pat:
        ExpirationDate: "2040-01-01T00:00:00Z"
YAML
  chmod 0600 "$config_dir/public.yaml" "$config_dir/secrets.yaml" "$config_dir/steps.yaml" || return 1
}

rp_rollback_zitadel_stop() {
  if [[ -n "${zitadel_runtime_container:-}" ]] &&
     docker container inspect "$zitadel_runtime_container" >/dev/null 2>&1; then
    docker rm -f "$zitadel_runtime_container" >/dev/null || return 1
    if docker container inspect "$zitadel_runtime_container" >/dev/null 2>&1; then
      echo "Cannot certify ZITADEL rollback while a database writer is still running" >&2
      return 1
    fi
  fi
}


rp_rollback_zitadel_start() {
  local image="$1" phase="$2" config_dir="$root/zitadel-real-runtime" ready=false attempt
  rp_rollback_zitadel_stop || return 1
  docker run -d --name "$zitadel_runtime_container" --network "$db_network" \
    --user 0 -p 127.0.0.1:18080:8080 \
    -v "$config_dir/public.yaml:/zitadel-config.yaml:ro" \
    -v "$config_dir/secrets.yaml:/zitadel-secrets.yaml:ro" \
    -v "$config_dir/steps.yaml:/zitadel-steps.yaml:ro" \
    -v "$config_dir/bootstrap:/bootstrap" \
    "$image" start-from-init \
    --config /zitadel-config.yaml \
    --config /zitadel-secrets.yaml \
    --steps /zitadel-steps.yaml \
    --masterkey FederationMasterKey0123456789012 \
    --tlsMode disabled >/dev/null || return 1

  for ((attempt=0;attempt<120;attempt++)); do
    if curl --silent --fail --max-time 4 \
      -H 'Host: localhost:18080' \
      http://127.0.0.1:18080/debug/ready >/dev/null 2>&1; then
      ready=true
      break
    fi
    [[ "$(docker inspect "$zitadel_runtime_container" --format '{{.State.Running}}' 2>/dev/null)" == true ]] || break
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "Real $phase ZITADEL image failed readiness" >&2
    docker logs "$zitadel_runtime_container" --tail 60 >&2 || true
    return 1
  fi
  local issuer=""
  # ZITADEL may report runtime ready before the initial OIDC projection is
  # readable. Wait for real discovery, but never claim success based on ready.
  for ((attempt=0;attempt<45;attempt++)); do
    issuer="$(curl --fail --silent --max-time 8 \
      -H 'Host: localhost:18080' \
      http://127.0.0.1:18080/.well-known/openid-configuration 2>/dev/null |
      jq -er '.issuer' 2>/dev/null)" || issuer=""
    [[ "$issuer" == "http://localhost:18080" ]] && break
    sleep 2
  done
  [[ "$issuer" == "http://localhost:18080" ]] || {
    echo "Real $phase ZITADEL OIDC discovery did not report the trusted issuer" >&2
    return 1
  }
  [[ "$(docker inspect "$zitadel_runtime_container" --format '{{.Config.Image}}')" == "$image" ]] || {
    echo "ZITADEL running image differs from pinned $phase digest" >&2
    return 1
  }
}

rp_rollback_zitadel_schema_inventory() {
  docker exec "$zitadel_db_container" psql -U postgres -d zitadel -At -v ON_ERROR_STOP=1 \
    -c "SELECT string_agg(table_schema || '.' || table_name, ',' ORDER BY table_schema, table_name)
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
        AND table_type='BASE TABLE';"
}
rp_rollback_zitadel_events() {
  docker exec "$zitadel_db_container" psql -U postgres -d zitadel -At -v ON_ERROR_STOP=1 \
    -c 'SELECT count(*) FROM eventstore.events2;'
}
rp_rollback_zitadel_event_fingerprints() {
  # Hash every immutable event including payload. Post-restart ZITADEL may
  # append its own legitimate events, so a count-only comparison is invalid.
  # A previously committed source event may NEVER disappear or change.
  docker exec "$zitadel_db_container" psql -U postgres -d zitadel     -At -v ON_ERROR_STOP=1 -c     'SELECT md5(row_to_json(e)::text) FROM eventstore.events2 AS e ORDER BY 1;'
}

rp_rollback_zitadel_capture_source() {
  zitadel_source_schema_inventory="$(rp_rollback_zitadel_schema_inventory)" || return 1
  [[ "$zitadel_source_schema_inventory" == *"eventstore.events2"* ]] || {
    echo "Published ZITADEL eventstore schema was never initialized" >&2
    return 1
  }
  zitadel_source_events="$(rp_rollback_zitadel_events)" || return 1
  [[ "$zitadel_source_events" =~ ^[1-9][0-9]*$ ]] || {
    echo "Published ZITADEL has no persisted source eventstore events" >&2
    return 1
  }
  rp_rollback_zitadel_event_fingerprints >"$root/source-zitadel-events.sha256" || return 1
  [[ -s "$root/source-zitadel-events.sha256" ]] || return 1
  [[ "$(wc -l < "$root/source-zitadel-events.sha256")" -eq "$zitadel_source_events" ]] || return 1
}
rp_rollback_zitadel_verify_restored_source() {
  local schema restored_events
  rp_rollback_zitadel_start "$source_zitadel" "restored published source" || return 1
  schema="$(rp_rollback_zitadel_schema_inventory)" || return 1
  [[ "$schema" == "$zitadel_source_schema_inventory" ]] || {
    echo "Real ZITADEL source eventstore schema differs after restore" >&2
    return 1
  }
  restored_events="$(rp_rollback_zitadel_events)" || return 1
  [[ "$restored_events" =~ ^[0-9]+$ && "$restored_events" -ge "$zitadel_source_events" ]] || {
    echo "Real ZITADEL lost source eventstore entries after restore" >&2
    return 1
  }
  rp_rollback_zitadel_event_fingerprints >"$root/restored-zitadel-events.sha256" || return 1
  # Ignore legitimately appended startup events but reject deleted or
  # modified source events, including identity/authorization payloads.
  if [[ -n "$(comm -23 "$root/source-zitadel-events.sha256" "$root/restored-zitadel-events.sha256")" ]]; then
    echo "Restored ZITADEL lost or changed source eventstore event payloads" >&2
    return 1
  fi
}
