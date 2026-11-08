#!/usr/bin/env bash

rp_merge_platform_admin_ids() {
  local existing="$1" additions="$2" item
  local -a output=()
  declare -A seen=()
  local combined
  combined="${existing}${existing:+,}${additions}"
  IFS=',' read -ra items <<<"$combined"
  for item in "${items[@]}"; do
    item="${item//[[:space:]]/}"
    [[ -n "$item" ]] || continue
    if [[ -z "${seen[$item]+x}" ]]; then
      output+=("$item")
      seen[$item]=1
    fi
  done
  local joined=""
  for item in "${output[@]}"; do
    joined+="${joined:+,}$item"
  done
  printf '%s\n' "$joined"
}

rp_admin_password_valid() {
  local password="$1"
  ((${#password} >= 12)) || return 1
  [[ "$password" =~ [a-z] ]] || return 1
  [[ "$password" =~ [A-Z] ]] || return 1
  [[ "$password" =~ [0-9] ]] || return 1
  [[ "$password" =~ [^A-Za-z0-9] ]] || return 1
}

rp_render_zitadel_public_config() {
  local domain="$1"
  cat <<EOF_CONFIG
Log:
  Level: info
Port: 8080
ExternalDomain: $domain
ExternalPort: 443
ExternalSecure: true
TLS:
  Enabled: false
Database:
  postgres:
    Host: postgres-zitadel
    Port: 5432
    Database: zitadel
    User:
      SSL:
        Mode: disable
    Admin:
      SSL:
        Mode: disable
EOF_CONFIG
}

rp_swarm_config_exists() {
  docker config inspect "$1" >/dev/null 2>&1
}

rp_versioned_swarm_config_name() {
  local logical_name="$1" source_file="$2" digest
  [[ "$logical_name" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  [[ "$source_file" == /* && -r "$source_file" ]] || return 1
  digest="$(sha256sum "$source_file" | awk '{print substr($1,1,16)}')" || return 1
  [[ "$digest" =~ ^[a-fA-F0-9]{16}$ ]] || return 1
  printf '%s_%s\n' "$logical_name" "$digest"
}

rp_ensure_versioned_swarm_config() {
  local logical_name="$1" source_file="$2" versioned_name
  versioned_name="$(rp_versioned_swarm_config_name "$logical_name" "$source_file")" || return 1
  if ! rp_swarm_config_exists "$versioned_name"; then
    docker config create "$versioned_name" "$source_file" >/dev/null || return 1
  fi
  printf '%s\n' "$versioned_name"
}

rp_prepare_zitadel_public_config() {
  local target="${RP_ZITADEL_PUBLIC_CONFIG_PATH:-/etc/resourceportal/zitadel-config.yaml}" tmp ref
  [[ -n "${RP_CFG_ZITADEL_DOMAIN:-}" ]] || return 1
  tmp="$(mktemp /tmp/resourceportal-zitadel-public.XXXXXX)" || return 1
  if ! rp_render_zitadel_public_config "$RP_CFG_ZITADEL_DOMAIN" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mkdir -p "$(dirname "$target")" || { rm -f "$tmp"; return 1; }
  install -m 0644 "$tmp" "$target" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  ref="$(rp_ensure_versioned_swarm_config zitadel_public_config "$target")" || return 1
  RP_CFG_ZITADEL_PUBLIC_CONFIG_REF="$ref"
  export RP_CFG_ZITADEL_PUBLIC_CONFIG_REF
}

rp_render_zitadel_secret_config() {
  local db_user="$1" db_password="$2" admin_password="$3"
  cat <<EOF_CONFIG
Database:
  postgres:
    User:
      Username: $db_user
      Password: $db_password
    Admin:
      Username: postgres
      Password: $admin_password
EOF_CONFIG
}

rp_render_zitadel_init_steps() {
  local bootstrap_username="$1" bootstrap_password="$2"
  cat <<EOF_STEPS
FirstInstance:
  PatPath: /zitadel/bootstrap/admin.pat
  Org:
    Human:
      Username: $bootstrap_username
      Password: $bootstrap_password
      PasswordChangeRequired: false
    Machine:
      Machine:
        Username: resource-portal-bootstrap
        Name: ResourcePortal Installer Bootstrap
      Pat:
        ExpirationDate: "2040-01-01T00:00:00Z"
EOF_STEPS
}

rp_prepare_api_bootstrap_output_dir() {
  local path="$1" image="$2" owner
  [[ -n "$path" && -n "$image" ]] || return 1
  owner="$(docker run --rm --entrypoint sh "$image" -c 'printf "%s:%s\n" "$(id -u node)" "$(id -g node)"')" || return 1
  [[ "$owner" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  install -d -m 0700 "$path" || return 1
  chown "$owner" "$path" || return 1
  chmod 0700 "$path" || return 1
}

rp_run_zitadel_bootstrap() {
  local output_file="$1" admin_username="$2" admin_email="$3" admin_password_file="$4"
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}" elapsed=0 state
  local state_dir output_dir output_name suffix readiness_script bootstrap_command
  service_name="${stack_name}-zitadel-bootstrap-$(date +%s)"
  [[ "$output_file" == /* && "$admin_password_file" == /* && -r "$admin_password_file" ]] || return 1
  rp_admin_password_valid "$(cat "$admin_password_file")" || return 1
  state_dir="$(dirname "$output_file")"
  output_name="$(basename "$output_file")"
  output_dir="$state_dir/identity-bootstrap"
  install -d -m 0700 "$state_dir"
  rm -f "$output_file" "$output_file.client-id" "$output_file.client-secret" "$output_file.cli-client-id" "$output_file.user-id" "$output_file.organization-id" "$output_file.project-id"
  rm -rf "$output_dir"
  rp_prepare_api_bootstrap_output_dir "$output_dir" "${RP_CFG_API_IMAGE:?RP_CFG_API_IMAGE is required}" || return 1

  readiness_script='const base=process.env.ZITADEL_ISSUER_URL; const host=process.env.ZITADEL_BOOTSTRAP_INSTANCE_HOST; const timeout=Number(process.env.ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS||"300")*1000; const headers=host?{"x-zitadel-instance-host":host,"x-zitadel-public-host":host}:{}; const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)); (async()=>{const deadline=Date.now()+timeout; while(Date.now()<deadline){try{const response=await fetch(`${base}/debug/ready`,{headers}); if(response.ok){process.exit(0);}}catch{} await sleep(1000);} console.error("ZITADEL readiness timed out"); process.exit(1);})().catch(()=>process.exit(1));'
  bootstrap_command='node -e "$RP_ZITADEL_READY_SCRIPT" && exec node dist/scripts/bootstrap-zitadel.js'

  docker service create \
    --detach \
    --name "$service_name" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.rp.node.storage==true' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --mount type=bind,src=/mnt/resourceportal/platform/zitadel-bootstrap,dst=/platform/zitadel-bootstrap \
    --mount type=bind,src="$output_dir",dst=/bootstrap-output \
    --secret source="${RP_CFG_OIDC_SWARM_REF:-rp_oidc_client_secret_bootstrap}",target=rp_oidc_client_secret \
    --secret source=rp_first_admin_password,target=rp_first_admin_password \
    --secret source=rp_encryption_key,target=rp_encryption_key \
    --env FEDERATION_ATTESTATION_MASTER_FILE=/run/secrets/rp_encryption_key \
    --env FEDERATION_ATTESTATION_CALLBACK_URL=http://api:3000/api/auth/federation/attest \
    --env ZITADEL_BOOTSTRAP_MODE=production \
    --env ZITADEL_ISSUER_URL=http://zitadel:8080 \
    --env ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS="$timeout" \
    --env "RP_ZITADEL_READY_SCRIPT=$readiness_script" \
    --env ZITADEL_BOOTSTRAP_INSTANCE_HOST="${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" \
    --env ZITADEL_BOOTSTRAP_PAT_FILE=/platform/zitadel-bootstrap/admin.pat \
    --env ZITADEL_BOOTSTRAP_ADMIN_USERNAME="$admin_username" \
    --env ZITADEL_BOOTSTRAP_ADMIN_EMAIL="$admin_email" \
    --env ZITADEL_BOOTSTRAP_ADMIN_PASSWORD_FILE=/run/secrets/rp_first_admin_password \
    --env OIDC_CLIENT_SECRET_FILE=/run/secrets/rp_oidc_client_secret \
    --env ZITADEL_BOOTSTRAP_REDIRECT_URIS="https://${RP_CFG_DOMAIN}/api/auth/callback" \
    --env ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS="https://${RP_CFG_DOMAIN}/api/auth/logout/callback" \
    --env ZITADEL_BOOTSTRAP_OUTPUT_FILE="/bootstrap-output/$output_name" \
    --entrypoint /bin/sh \
    "$RP_CFG_API_IMAGE" \
    -ec "$bootstrap_command" >/dev/null || { rm -rf "$output_dir"; return 1; }

  while (( elapsed < timeout )); do
    state="$(docker service ps --no-trunc --format '{{.CurrentState}}|{{.Error}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*)
        docker service rm "$service_name" >/dev/null
        chown -R root:root "$output_dir" || return 1
        chmod 0700 "$output_dir" || return 1
        find "$output_dir" -maxdepth 1 -type f -exec chmod 0600 {} + || return 1
        for suffix in '' '.client-id' '.client-secret' '.cli-client-id' '.user-id' '.organization-id' '.project-id'; do
          [[ -r "$output_dir/$output_name$suffix" ]] || return 1
          mv -f "$output_dir/$output_name$suffix" "$output_file$suffix" || return 1
        done
        rmdir "$output_dir" || return 1
        return 0
        ;;
      Failed*|Rejected*)
        docker service logs "$service_name" >&2 || true
        docker service rm "$service_name" >/dev/null || true
        rm -rf "$output_dir"
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service logs "$service_name" >&2 || true
  docker service rm "$service_name" >/dev/null || true
  rm -rf "$output_dir"
  printf 'ZITADEL identity bootstrap timed out.\n' >&2
  return 1
}

rp_run_zitadel_cli_reconcile() {
  local output_file="$1" stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}" elapsed=0 state
  local state_dir output_dir output_name readiness_script bootstrap_command
  [[ "$output_file" == /* ]] || return 1
  rp_zitadel_management_state_ready || return 1
  state_dir="$(dirname "$output_file")"
  output_name="$(basename "$output_file")"
  output_dir="$state_dir/identity-cli-reconcile"
  service_name="${stack_name}-zitadel-cli-reconcile-$(date +%s)"
  install -d -m 0700 "$state_dir"
  rm -f "$output_file" "$output_file.cli-client-id"
  rm -rf "$output_dir"
  rp_prepare_api_bootstrap_output_dir "$output_dir" "${RP_CFG_API_IMAGE:?RP_CFG_API_IMAGE is required}" || return 1

  readiness_script='const base=process.env.ZITADEL_ISSUER_URL; const host=process.env.ZITADEL_BOOTSTRAP_INSTANCE_HOST; const timeout=Number(process.env.ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS||"300")*1000; const headers=host?{"x-zitadel-instance-host":host,"x-zitadel-public-host":host}:{}; const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)); (async()=>{const deadline=Date.now()+timeout; while(Date.now()<deadline){try{const response=await fetch(`${base}/debug/ready`,{headers}); if(response.ok){process.exit(0);}}catch{} await sleep(1000);} console.error("ZITADEL readiness timed out"); process.exit(1);})().catch(()=>process.exit(1));'
  bootstrap_command='node -e "$RP_ZITADEL_READY_SCRIPT" && exec node dist/scripts/bootstrap-zitadel.js'

  docker service create \
    --detach \
    --name "$service_name" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.rp.node.storage==true' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --mount type=bind,src=/mnt/resourceportal/platform/zitadel-bootstrap,dst=/platform/zitadel-bootstrap \
    --mount type=bind,src="$output_dir",dst=/bootstrap-output \
    --env ZITADEL_BOOTSTRAP_MODE=production \
    --env ZITADEL_BOOTSTRAP_CLI_ONLY=true \
    --env ZITADEL_ISSUER_URL=http://zitadel:8080 \
    --env ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS="$timeout" \
    --env "RP_ZITADEL_READY_SCRIPT=$readiness_script" \
    --env ZITADEL_BOOTSTRAP_INSTANCE_HOST="${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" \
    --env ZITADEL_BOOTSTRAP_PAT_FILE=/platform/zitadel-bootstrap/admin.pat \
    --env ZITADEL_ORGANIZATION_ID="$RP_CFG_ZITADEL_ORGANIZATION_ID" \
    --env ZITADEL_PROJECT_ID="$RP_CFG_ZITADEL_PROJECT_ID" \
    --env ZITADEL_BOOTSTRAP_OUTPUT_FILE="/bootstrap-output/$output_name" \
    --entrypoint /bin/sh \
    "$RP_CFG_API_IMAGE" \
    -ec "$bootstrap_command" >/dev/null || { rm -rf "$output_dir"; return 1; }

  while (( elapsed < timeout )); do
    state="$(docker service ps --no-trunc --format '{{.CurrentState}}|{{.Error}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*)
        docker service rm "$service_name" >/dev/null
        chown -R root:root "$output_dir" || return 1
        chmod 0700 "$output_dir" || return 1
        find "$output_dir" -maxdepth 1 -type f -exec chmod 0600 {} + || return 1
        for suffix in '' '.cli-client-id'; do
          [[ -r "$output_dir/$output_name$suffix" ]] || return 1
          mv -f "$output_dir/$output_name$suffix" "$output_file$suffix" || return 1
        done
        rmdir "$output_dir" || return 1
        return 0
        ;;
      Failed*|Rejected*)
        docker service logs "$service_name" >&2 || true
        docker service rm "$service_name" >/dev/null || true
        rm -rf "$output_dir"
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service logs "$service_name" >&2 || true
  docker service rm "$service_name" >/dev/null || true
  rm -rf "$output_dir"
  printf 'ZITADEL CLI client reconciliation timed out.\n' >&2
  return 1
}

rp_run_zitadel_mcp_oauth_reconcile() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}" elapsed=0 state
  local readiness_script bootstrap_command
  local pat_file="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"

  rp_zitadel_management_state_ready || return 1
  [[ -r "$pat_file" ]] || {
    printf 'ZITADEL management PAT is unavailable for MCP OAuth reconciliation: %s\n' "$pat_file" >&2
    return 1
  }

  service_name="${stack_name}-zitadel-mcp-oauth-$(date +%s)"
  # A green /debug/ready does not prove that the authenticated Admin gRPC bridge is ready.
  # This gate is read-only; failed authorization is permanent, never retried.
  readiness_script='const fs=require("node:fs"); const base=process.env.ZITADEL_ISSUER_URL; const host=process.env.ZITADEL_BOOTSTRAP_INSTANCE_HOST; const timeout=Number(process.env.ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS||"300")*1000; const pat=fs.readFileSync(process.env.ZITADEL_BOOTSTRAP_PAT_FILE,"utf8").trim(); if(!pat)throw Error("missing management PAT"); const headers={authorization:`Bearer ${pat}`,...(host?{"x-zitadel-instance-host":host,"x-zitadel-public-host":host}:{})}; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); (async()=>{const started=Date.now(),deadline=started+timeout;let attempt=0,last="unavailable";while(Date.now()<deadline){attempt++;try{const response=await fetch(`${base}/admin/v1/policies/label`,{headers,signal:AbortSignal.timeout(Math.min(5000,Math.max(1000,deadline-Date.now())))});if(response.ok){console.log(`ZITADEL authenticated Admin API ready after ${Date.now()-started}ms (${attempt} attempts)`);return;}last=`HTTP ${response.status}`;if(![429,502,503,504].includes(response.status)){console.error(`ZITADEL Admin API readiness permanent failure: ${last}`);process.exitCode=1;return;}}catch(e){last=e?.cause?.code||e?.code||"transport unavailable";}await sleep(Math.min(5000,500*2**Math.min(attempt-1,4),Math.max(0,deadline-Date.now())));}console.error(`ZITADEL Admin API readiness deadline exceeded (${Date.now()-started}ms, ${attempt} attempts, last=${last})`);process.exitCode=1;})().catch(e=>{console.error("ZITADEL Admin API readiness failed:",e.message);process.exitCode=1;});'
  bootstrap_command='node -e "$RP_ZITADEL_READY_SCRIPT" && exec node dist/scripts/bootstrap-zitadel.js'

  docker service create \
    --detach \
    --name "$service_name" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.rp.node.storage==true' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --mount type=bind,src=/mnt/resourceportal/platform/zitadel-bootstrap,dst=/platform/zitadel-bootstrap,readonly \
    --secret source=rp_encryption_key,target=rp_encryption_key \
    --env FEDERATION_ATTESTATION_MASTER_FILE=/run/secrets/rp_encryption_key \
    --env FEDERATION_ATTESTATION_CALLBACK_URL=http://api:3000/api/auth/federation/attest \
    --env ZITADEL_ORGANIZATION_ID="${RP_CFG_ZITADEL_ORGANIZATION_ID:-}" \
    --env ZITADEL_BOOTSTRAP_MODE=production \
    --env ZITADEL_BOOTSTRAP_MCP_OAUTH_ONLY=true \
    --env ZITADEL_ISSUER_URL=http://zitadel:8080 \
    --env ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS="$timeout" \
    --env "RP_ZITADEL_READY_SCRIPT=$readiness_script" \
    --env ZITADEL_BOOTSTRAP_INSTANCE_HOST="${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" \
    --env ZITADEL_BOOTSTRAP_PAT_FILE=/platform/zitadel-bootstrap/admin.pat \
    --entrypoint /bin/sh \
    "${RP_CFG_API_IMAGE:?RP_CFG_API_IMAGE is required}" \
    -ec "$bootstrap_command" >/dev/null || return 1

  while (( elapsed < timeout )); do
    state="$(docker service ps --no-trunc --format '{{.CurrentState}}|{{.Error}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*)
        docker service rm "$service_name" >/dev/null
        return 0
        ;;
      Failed*|Rejected*)
        docker service logs "$service_name" >&2 || true
        docker service rm "$service_name" >/dev/null || true
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service logs "$service_name" >&2 || true
  docker service rm "$service_name" >/dev/null || true
  printf 'ZITADEL MCP OAuth reconciliation timed out.\n' >&2
  return 1
}

rp_run_zitadel_web_oidc_reconcile() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service_name timeout="${RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS:-300}" elapsed=0 state
  local readiness_script bootstrap_command
  local pat_file="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"

  rp_zitadel_management_state_ready || return 1
  [[ -n "${RP_CFG_OIDC_CLIENT_ID:-}" && "${RP_CFG_OIDC_CLIENT_ID:-}" != bootstrap-pending ]] || return 1
  [[ -r "$pat_file" ]] || {
    printf 'ZITADEL management PAT is unavailable for Web OIDC reconciliation: %s\n' "$pat_file" >&2
    return 1
  }

  service_name="${stack_name}-zitadel-web-oidc-$(date +%s)"
  readiness_script='const base=process.env.ZITADEL_ISSUER_URL; const host=process.env.ZITADEL_BOOTSTRAP_INSTANCE_HOST; const timeout=Number(process.env.ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS||"300")*1000; const headers=host?{"x-zitadel-instance-host":host,"x-zitadel-public-host":host}:{}; const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)); (async()=>{const deadline=Date.now()+timeout; while(Date.now()<deadline){try{const response=await fetch(`${base}/debug/ready`,{headers}); if(response.ok){process.exit(0);}}catch{} await sleep(1000);} console.error("ZITADEL readiness timed out"); process.exit(1);})().catch(()=>process.exit(1));'
  bootstrap_command='node -e "$RP_ZITADEL_READY_SCRIPT" && exec node dist/scripts/bootstrap-zitadel.js'

  docker service create \
    --detach \
    --name "$service_name" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.rp.node.storage==true' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --mount type=bind,src=/mnt/resourceportal/platform/zitadel-bootstrap,dst=/platform/zitadel-bootstrap,readonly \
    --env ZITADEL_BOOTSTRAP_MODE=production \
    --env ZITADEL_BOOTSTRAP_WEB_OIDC_ONLY=true \
    --env ZITADEL_ISSUER_URL=http://zitadel:8080 \
    --env ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS="$timeout" \
    --env "RP_ZITADEL_READY_SCRIPT=$readiness_script" \
    --env ZITADEL_BOOTSTRAP_INSTANCE_HOST="${RP_CFG_ZITADEL_DOMAIN:?RP_CFG_ZITADEL_DOMAIN is required}" \
    --env ZITADEL_BOOTSTRAP_PAT_FILE=/platform/zitadel-bootstrap/admin.pat \
    --env ZITADEL_ORGANIZATION_ID="${RP_CFG_ZITADEL_ORGANIZATION_ID:?}" \
    --env ZITADEL_PROJECT_ID="${RP_CFG_ZITADEL_PROJECT_ID:?}" \
    --env OIDC_CLIENT_ID="${RP_CFG_OIDC_CLIENT_ID:?}" \
    --env ZITADEL_BOOTSTRAP_REDIRECT_URIS="https://${RP_CFG_DOMAIN:?}/api/auth/callback" \
    --env ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS="https://${RP_CFG_DOMAIN}/api/auth/logout/callback" \
    --entrypoint /bin/sh \
    "${RP_CFG_API_IMAGE:?RP_CFG_API_IMAGE is required}" \
    -ec "$bootstrap_command" >/dev/null || return 1

  while (( elapsed < timeout )); do
    state="$(docker service ps --no-trunc --format '{{.CurrentState}}|{{.Error}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*)
        docker service rm "$service_name" >/dev/null
        return 0
        ;;
      Failed*|Rejected*)
        docker service logs "$service_name" >&2 || true
        docker service rm "$service_name" >/dev/null || true
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  docker service logs "$service_name" >&2 || true
  docker service rm "$service_name" >/dev/null || true
  printf 'ZITADEL Web OIDC reconciliation timed out.\n' >&2
  return 1
}

rp_recover_zitadel_cli_client_state() {
  local output_file="${1:-/var/lib/resourceportal/installer-state/zitadel-bootstrap.json}"
  local cli_client_id_file="${output_file}.cli-client-id" cli_client_id reconcile_output
  if [[ -n "${RP_CFG_OIDC_CLI_CLIENT_ID:-}" && "${RP_CFG_OIDC_CLI_CLIENT_ID:-}" != bootstrap-pending ]]; then
    return 0
  fi

  if [[ -r "$cli_client_id_file" ]]; then
    cli_client_id="$(tr -d '\r\n' <"$cli_client_id_file")"
  elif [[ -r "$output_file" ]] && command -v jq >/dev/null 2>&1; then
    cli_client_id="$(jq -r '.cliClientId // empty' "$output_file")"
  fi

  if [[ -z "${cli_client_id:-}" ]]; then
    rp_zitadel_management_state_ready || return 1
    reconcile_output="${output_file}.cli-reconcile"
    rp_run_zitadel_cli_reconcile "$reconcile_output" || return 1
    [[ -r "${reconcile_output}.cli-client-id" ]] || return 1
    cli_client_id="$(tr -d '\r\n' <"${reconcile_output}.cli-client-id")"
    [[ -n "$cli_client_id" ]] || return 1
    umask 077
    printf '%s\n' "$cli_client_id" >"$cli_client_id_file" || return 1
    chmod 0600 "$cli_client_id_file" || return 1
    rm -f "$reconcile_output" "${reconcile_output}.cli-client-id"
  fi

  [[ -n "$cli_client_id" ]] || return 1
  RP_CFG_OIDC_CLI_CLIENT_ID="$cli_client_id"
  export RP_CFG_OIDC_CLI_CLIENT_ID
}

rp_zitadel_management_state_ready() {
  [[ -n "${RP_CFG_ZITADEL_ORGANIZATION_ID:-}" && "${RP_CFG_ZITADEL_ORGANIZATION_ID:-}" != bootstrap-pending ]] || return 1
  [[ -n "${RP_CFG_ZITADEL_PROJECT_ID:-}" && "${RP_CFG_ZITADEL_PROJECT_ID:-}" != bootstrap-pending ]] || return 1
  [[ -n "${RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF:-}" ]] || return 1
}

rp_recover_zitadel_management_state() {
  local output_file="${1:-/var/lib/resourceportal/installer-state/zitadel-bootstrap.json}"
  local management_pat_file="${2:-${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}}"
  local organization_id_file="${output_file}.organization-id" project_id_file="${output_file}.project-id"
  local organization_id project_id management_secret_ref

  rp_zitadel_management_state_ready && return 0
  [[ "$output_file" == /* && "$management_pat_file" == /* && -r "$management_pat_file" ]] || return 1

  if [[ -r "$organization_id_file" && -r "$project_id_file" ]]; then
    organization_id="$(tr -d '\r\n' <"$organization_id_file")"
    project_id="$(tr -d '\r\n' <"$project_id_file")"
  else
    [[ -r "$output_file" ]] || return 1
    command -v jq >/dev/null 2>&1 || return 1
    organization_id="$(jq -er '.organizationId | strings | select(length > 0)' "$output_file")" || return 1
    project_id="$(jq -er '.projectId | strings | select(length > 0)' "$output_file")" || return 1
  fi
  [[ -n "$organization_id" && -n "$project_id" ]] || return 1

  management_secret_ref="$(rp_ensure_versioned_swarm_secret rp_zitadel_management_token "$management_pat_file")" || return 1
  RP_CFG_ZITADEL_ORGANIZATION_ID="$organization_id"
  RP_CFG_ZITADEL_PROJECT_ID="$project_id"
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF="$management_secret_ref"
  export RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
}

rp_apply_zitadel_bootstrap_output() {
  local output_file="$1" client_id_file cli_client_id_file secret_file user_id_file organization_id_file project_id_file
  local client_id cli_client_id user_id organization_id project_id oidc_secret_ref management_secret_ref
  local management_pat_file="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"
  client_id_file="${output_file}.client-id"
  cli_client_id_file="${output_file}.cli-client-id"
  secret_file="${output_file}.client-secret"
  user_id_file="${output_file}.user-id"
  organization_id_file="${output_file}.organization-id"
  project_id_file="${output_file}.project-id"
  [[ "$output_file" == /* && "$management_pat_file" == /* && -r "$output_file" && -r "$client_id_file" && -r "$cli_client_id_file" && -r "$secret_file" && -r "$user_id_file" && -r "$organization_id_file" && -r "$project_id_file" && -r "$management_pat_file" ]] || return 1

  client_id="$(tr -d '\r\n' <"$client_id_file")"
  cli_client_id="$(tr -d '\r\n' <"$cli_client_id_file")"
  user_id="$(tr -d '\r\n' <"$user_id_file")"
  organization_id="$(tr -d '\r\n' <"$organization_id_file")"
  project_id="$(tr -d '\r\n' <"$project_id_file")"
  [[ -n "$client_id" && -n "$cli_client_id" && -n "$user_id" && -n "$organization_id" && -n "$project_id" ]] || return 1

  oidc_secret_ref="$(rp_ensure_versioned_swarm_secret rp_oidc_client_secret "$secret_file")" || return 1
  management_secret_ref="$(rp_ensure_versioned_swarm_secret rp_zitadel_management_token "$management_pat_file")" || return 1
  RP_CFG_OIDC_CLIENT_ID="$client_id"
  RP_CFG_OIDC_CLI_CLIENT_ID="$cli_client_id"
  RP_CFG_OIDC_SWARM_REF="$oidc_secret_ref"
  RP_CFG_ZITADEL_ORGANIZATION_ID="$organization_id"
  RP_CFG_ZITADEL_PROJECT_ID="$project_id"
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF="$management_secret_ref"
  # The bootstrap user id is the stable subject issued by the primary ZITADEL
  # instance. PlatformAdminGuard resolves these configured subjects through the
  # authenticated ResourcePortal UserIdentity; existing internal RP user UUIDs
  # remain accepted for backward compatibility.
  RP_CFG_PLATFORM_ADMIN_IDS="$(rp_merge_platform_admin_ids "${RP_CFG_PLATFORM_ADMIN_IDS:-}" "$user_id")"
  export RP_CFG_OIDC_CLIENT_ID RP_CFG_OIDC_CLI_CLIENT_ID RP_CFG_OIDC_SWARM_REF RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF RP_CFG_PLATFORM_ADMIN_IDS

  rp_remove_secret_file "$secret_file"
}

# App Consumer Actions V2 authorization is a GLOBAL preaccesstoken execution.
# Enrollment is deliberately explicit, never an ordinary installer/upgrade
# step. The operator first configures a signed, interrupting HTTPS target in
# isolated ZITADEL and certifies normal RP logins and downstream client grants.
# Only after verifying the live read-back can the installer stage a versioned
# Docker secret and mark the local API config ready for deployment.
#
# The PAT and HMAC key are read solely from existing protected files; neither
# is passed in process arguments or printed in logs.
rp_verify_app_consumer_actions_v2_binding() (
  local target_id="${1:-}" key_file="${2:-}"
  local pat_file="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"
  local auth_host="${RP_CFG_ZITADEL_DOMAIN:-}" rp_host="${RP_CFG_DOMAIN:-}"
  local org_id="${RP_CFG_ZITADEL_ORGANIZATION_ID:-}" pat key_len callback tmp
  [[ "$target_id" =~ ^[0-9]{1,64}$ ]] || return 1
  [[ "$auth_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ &&
     "$rp_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ &&
     "$org_id" =~ ^[0-9]{1,64}$ ]] || return 1
  [[ "$key_file" == /* && -f "$key_file" && -r "$key_file" &&
     "$pat_file" == /* && -f "$pat_file" && -r "$pat_file" ]] || return 1
  key_len="$(wc -c < "$key_file")" || return 1
  [[ "$key_len" =~ ^[0-9]+$ && "$key_len" -ge 32 && "$key_len" -le 512 ]] || return 1
  IFS= read -r pat < "$pat_file" || [[ -n "$pat" ]] || return 1
  [[ "$pat" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || return 1
  command -v curl >/dev/null && command -v jq >/dev/null || return 1
  callback="https://${rp_host}/api/app-consumer-actions/preaccesstoken"
  tmp="$(mktemp -d)" || return 1
  chmod 0700 "$tmp" || return 1
  trap 'rm -rf -- "$tmp"' EXIT

  # curl --config uses a private mode-0600 temporary file instead of putting
  # Bearer credentials in process args, and TLS redirect is never followed.
  ( umask 077
    printf 'header = "Authorization: Bearer %s"\nheader = "x-zitadel-orgid: %s"\n' "$pat" "$org_id"
  ) > "$tmp/curl.conf" || return 1
  unset pat
  local base="https://${auth_host}"
  if ! curl --silent --show-error --fail --no-location --proto '=https' \
      --max-time 15 --config "$tmp/curl.conf" \
      --output "$tmp/target.json" "$base/v2/actions/targets/$target_id" >/dev/null 2>&1; then
    printf 'ZITADEL App Consumer Actions V2 target verification unavailable.\n' >&2
    return 1
  fi
  if ! jq -e --arg id "$target_id" --arg endpoint "$callback" --rawfile key "$key_file" '
    .target.id == $id and
    .target.endpoint == $endpoint and
    .target.payloadType == "PAYLOAD_TYPE_JSON" and
    .target.restWebhook.interruptOnError == true and
    .target.signingKey == ($key | rtrimstr("\n") | rtrimstr("\r"))
  ' "$tmp/target.json" >/dev/null 2>&1; then
    printf 'ZITADEL App Consumer Actions V2 target or signing key mismatch.\n' >&2
    return 1
  fi
  if ! curl --silent --show-error --fail --no-location --proto '=https' \
      --max-time 15 --config "$tmp/curl.conf" \
      -H 'Content-Type: application/json' --request POST \
      --data '{"pagination":{"limit":100}}' \
      --output "$tmp/executions.json" "$base/v2/actions/executions/search" >/dev/null 2>&1; then
    printf 'ZITADEL App Consumer Actions V2 execution verification unavailable.\n' >&2
    return 1
  fi
  if ! jq -e --arg id "$target_id" '
    (.executions | type == "array") and
    ((.pagination.totalResult | tonumber) == (.executions | length)) and
    (([.executions[] | select(.condition.function.name == "preaccesstoken")] | length) == 1) and
    (([.executions[] | select(.condition.function.name == "preaccesstoken")] | .[0].targets) == [$id])
  ' "$tmp/executions.json" >/dev/null 2>&1; then
    printf 'ZITADEL App Consumer Actions V2 execution is not exclusive and fully verified.\n' >&2
    return 1
  fi
)

rp_stage_app_consumer_actions_v2_binding() {
  local target_id="$1" key_file="$2" ref
  rp_verify_app_consumer_actions_v2_binding "$target_id" "$key_file" || return 1
  # Check all remote preconditions BEFORE creating a persistent Swarm secret.
  ref="$(rp_ensure_versioned_swarm_secret rp_app_consumer_action_hmac "$key_file")" || return 1
  [[ "$ref" =~ ^rp_app_consumer_action_hmac_[a-fA-F0-9]{16}$ ]] || return 1
  RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID="$target_id"
  RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF="$ref"
  RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
  export RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID \
    RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF \
    RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED
  # No config write or stack deploy here; an operator-controlled cutover with
  # rollback preparation is mandatory for an issuer-wide pre-token hook.
}

# Secure automatic App Consumer Actions V2 lifecycle.
source "$(dirname "${BASH_SOURCE[0]}")/app-consumer-actions.sh"
