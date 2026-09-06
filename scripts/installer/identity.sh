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

rp_run_zitadel_bootstrap() {
  local output_file="$1" admin_username="$2" admin_email="$3" admin_password_file="$4"
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  [[ "$output_file" == /* && "$admin_password_file" == /* && -r "$admin_password_file" ]] || return 1
  rp_admin_password_valid "$(cat "$admin_password_file")" || return 1
  install -d -m 0700 "$(dirname "$output_file")"
  rm -f "$output_file"

  docker service create \
    --name "${stack_name}-zitadel-bootstrap-$(date +%s)" \
    --restart-condition none \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --network "${stack_name}_rp-control" \
    --mount type=bind,src=/mnt/resourceportal/platform/zitadel-bootstrap,dst=/platform/zitadel-bootstrap \
    --mount type=bind,src="$(dirname "$output_file")",dst=/bootstrap-output \
    --secret source="${RP_CFG_OIDC_SWARM_REF:-rp_oidc_client_secret_bootstrap}",target=rp_oidc_client_secret \
    --secret source=rp_first_admin_password,target=rp_first_admin_password \
    --env ZITADEL_BOOTSTRAP_MODE=production \
    --env ZITADEL_ISSUER_URL=http://zitadel:8080 \
    --env ZITADEL_BOOTSTRAP_PAT_FILE=/platform/zitadel-bootstrap/admin.pat \
    --env ZITADEL_BOOTSTRAP_ADMIN_USERNAME="$admin_username" \
    --env ZITADEL_BOOTSTRAP_ADMIN_EMAIL="$admin_email" \
    --env ZITADEL_BOOTSTRAP_ADMIN_PASSWORD_FILE=/run/secrets/rp_first_admin_password \
    --env OIDC_CLIENT_SECRET_FILE=/run/secrets/rp_oidc_client_secret \
    --env ZITADEL_BOOTSTRAP_REDIRECT_URIS="https://${RP_CFG_DOMAIN}/api/auth/callback" \
    --env ZITADEL_BOOTSTRAP_POST_LOGOUT_REDIRECT_URIS="https://${RP_CFG_DOMAIN}/api/auth/logout/callback" \
    --env ZITADEL_BOOTSTRAP_OUTPUT_FILE="/bootstrap-output/$(basename "$output_file")" \
    "$RP_CFG_API_IMAGE" \
    node dist/scripts/bootstrap-zitadel.js >/dev/null
}


rp_apply_zitadel_bootstrap_output() {
  local output_file="$1" client_id_file secret_file user_id_file client_id user_id secret_ref
  client_id_file="${output_file}.client-id"
  secret_file="${output_file}.client-secret"
  user_id_file="${output_file}.user-id"
  [[ "$output_file" == /* && -r "$output_file" && -r "$client_id_file" && -r "$secret_file" && -r "$user_id_file" ]] || return 1

  client_id="$(tr -d '\r\n' <"$client_id_file")"
  user_id="$(tr -d '\r\n' <"$user_id_file")"
  [[ -n "$client_id" && -n "$user_id" ]] || return 1

  secret_ref="$(rp_ensure_versioned_swarm_secret rp_oidc_client_secret "$secret_file")" || return 1
  RP_CFG_OIDC_CLIENT_ID="$client_id"
  RP_CFG_OIDC_SWARM_REF="$secret_ref"
  RP_CFG_PLATFORM_ADMIN_IDS="$(rp_merge_platform_admin_ids "${RP_CFG_PLATFORM_ADMIN_IDS:-}" "$user_id")"
  export RP_CFG_OIDC_CLIENT_ID RP_CFG_OIDC_SWARM_REF RP_CFG_PLATFORM_ADMIN_IDS

  rp_remove_secret_file "$secret_file"
}
