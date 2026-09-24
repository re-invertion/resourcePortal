#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/config.sh"
source "$repo_root/scripts/installer/secrets.sh"
source "$repo_root/scripts/installer/identity.sh"
source "$repo_root/scripts/installer/control-plane.sh"
source "$repo_root/scripts/installer/swarm.sh"
source "$repo_root/scripts/installer/reset.sh"
source "$repo_root/scripts/installer/repair.sh"
source "$repo_root/scripts/installer/reconfigure.sh"
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || { printf 'expected=%s actual=%s\n' "$1" "$2" >&2; fail "$3"; }; }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3"; }
status(){ local e="$1" n="$2"; shift 2; set +e; "$@" >/tmp/rp-zm.out 2>/tmp/rp-zm.err; local a=$?; set -e; [[ "$a" == "$e" ]] && pass "$n" || { cat /tmp/rp-zm.err >&2 || true; fail "$n"; }; }

bootstrap_source="$(cat "$repo_root/packages/resourceportal-api/scripts/bootstrap-zitadel.ts")"
contains "$bootstrap_source" '["organization-id", organization.id]' 'production bootstrap emits organization id sidecar'
contains "$bootstrap_source" '["project-id", project.id]' 'production bootstrap emits project id sidecar'
not_contains "$bootstrap_source" '["management-token"' 'production bootstrap does not emit management PAT sidecar'
contains "$bootstrap_source" 'const cliAppName = "Resource Portal CLI"' 'bootstrap defines dedicated Resource Portal CLI app'
contains "$bootstrap_source" 'OIDC_GRANT_TYPE_DEVICE_CODE' 'CLI app enables device code grant'
contains "$bootstrap_source" 'OIDC_APP_TYPE_NATIVE' 'CLI app is native/public'
contains "$bootstrap_source" 'OIDC_AUTH_METHOD_TYPE_NONE' 'CLI app has no client authentication secret'
contains "$bootstrap_source" 'cliClientId: cliApp.clientId' 'production bootstrap emits CLI client id in JSON'
contains "$bootstrap_source" '["cli-client-id", cliApp.clientId]' 'production bootstrap emits CLI client id sidecar'
not_contains "$bootstrap_source" 'cliClientSecret' 'production bootstrap never emits a CLI client secret'
contains "$bootstrap_source" 'ZITADEL_BOOTSTRAP_CLI_ONLY' 'bootstrap supports CLI-only reconciliation for upgrades'
contains "$bootstrap_source" 'ZITADEL_BOOTSTRAP_MCP_OAUTH_ONLY' 'bootstrap supports MCP OAuth-only reconciliation for upgrades'
contains "$bootstrap_source" 'ZITADEL_BOOTSTRAP_WEB_OIDC_ONLY' 'bootstrap supports Web OIDC-only reconciliation for domain changes'
contains "$bootstrap_source" '"/v2/settings/security"' 'bootstrap configures ZITADEL security settings for MCP OAuth'
contains "$bootstrap_source" 'dynamicClientRegistration:' 'bootstrap configures Dynamic Client Registration'
contains "$bootstrap_source" 'allowUnauthenticated: true' 'bootstrap enables unauthenticated DCR required for automatic MCP client registration'
contains "$bootstrap_source" 'reconcileMcpDcrJwtAccessTokens' 'bootstrap reconciles DCR clients for MCP token compatibility'
contains "$bootstrap_source" 'accessTokenType: "OIDC_TOKEN_TYPE_JWT"' 'bootstrap forces DCR clients to JWT access tokens'
contains "$bootstrap_source" '"/zitadel.application.v2.ApplicationService/UpdateApplication"' 'bootstrap uses v2 partial application updates for DCR JWT compatibility'
contains "$bootstrap_source" '"connect-protocol-version": "1"' 'bootstrap authenticates application v2 updates with Connect protocol'
contains "$bootstrap_source" 'responseTypes: app.oidcConfig.responseTypes' 'bootstrap preserves DCR response types during JWT conversion'
contains "$bootstrap_source" 'grantTypes: app.oidcConfig.grantTypes' 'bootstrap preserves DCR grant types during JWT conversion'
not_contains "$bootstrap_source" 'apps/${app.id}/oidc_config' 'bootstrap no longer uses destructive legacy OIDC config PUT for DCR clients'
not_contains "$bootstrap_source" 'method === "PUT" &&' 'bootstrap accepts ZITADEL no-changes responses for v2 POST updates too'

secret_fixture="$(mktemp /tmp/rp-zitadel-management-secret.XXXXXX)"
printf 'management-token-material' >"$secret_fixture"
expected_hash="$(sha256sum "$secret_fixture" | awk '{print substr($1,1,16)}')"
eq "rp_zitadel_management_token_${expected_hash}" "$(rp_versioned_secret_name rp_zitadel_management_token "$secret_fixture")" 'management secret name is content-addressed'
rm -f "$secret_fixture"

fresh_install_provisions_management_state() (
  output="$(mktemp /tmp/rp-zitadel-output.XXXXXX.json)"
  management_pat="$(mktemp /tmp/rp-zitadel-pat.XXXXXX)"
  trap 'rm -f "$output" "$output.client-id" "$output.client-secret" "$output.cli-client-id" "$output.user-id" "$output.organization-id" "$output.project-id" "$management_pat"' EXIT
  printf '{}\n' >"$output"
  printf 'client-42\n' >"$output.client-id"
  printf 'oidc-secret-42\n' >"$output.client-secret"
  printf 'cli-client-42\n' >"$output.cli-client-id"
  printf 'admin-user-42\n' >"$output.user-id"
  printf 'org-42\n' >"$output.organization-id"
  printf 'project-42\n' >"$output.project-id"
  printf 'first-instance-pat-42\n' >"$management_pat"
  chmod 0600 "$management_pat"
  RP_ZITADEL_MANAGEMENT_PAT_FILE="$management_pat"
  RP_CFG_PLATFORM_ADMIN_IDS='existing-admin'
  export RP_ZITADEL_MANAGEMENT_PAT_FILE RP_CFG_PLATFORM_ADMIN_IDS
  rp_ensure_versioned_swarm_secret(){
    case "$1:$2" in
      "rp_oidc_client_secret:$output.client-secret") printf 'rp_oidc_client_secret_oidc42\n' ;;
      "rp_zitadel_management_token:$management_pat") printf 'rp_zitadel_management_token_management42\n' ;;
      *) return 1 ;;
    esac
  }
  rp_apply_zitadel_bootstrap_output "$output"
  [[ ! -e "$output.client-secret" ]] || return 1
  [[ -r "$management_pat" ]] || return 1
  [[ "$RP_CFG_OIDC_CLIENT_ID" == client-42 ]]
  [[ "$RP_CFG_OIDC_CLI_CLIENT_ID" == cli-client-42 ]]
  [[ "$RP_CFG_ZITADEL_ORGANIZATION_ID" == org-42 ]]
  [[ "$RP_CFG_ZITADEL_PROJECT_ID" == project-42 ]]
  [[ "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" == rp_zitadel_management_token_management42 ]]
  [[ "$RP_CFG_PLATFORM_ADMIN_IDS" == existing-admin,admin-user-42 ]]
)
status 0 'fresh install provisions management secret and metadata' fresh_install_provisions_management_state

legacy_install_reconciles_missing_cli_client() (
  output="$(mktemp /tmp/rp-zitadel-cli-reconcile.XXXXXX.json)"
  trap 'rm -f "$output" "$output.cli-client-id"' EXIT
  printf '%s\n' '{"organizationId":"org-legacy","projectId":"project-legacy"}' >"$output"
  RP_CFG_ZITADEL_ORGANIZATION_ID='org-legacy'
  RP_CFG_ZITADEL_PROJECT_ID='project-legacy'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_legacy42'
  unset RP_CFG_OIDC_CLI_CLIENT_ID
  export RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  reconcile_calls=0
  rp_run_zitadel_cli_reconcile(){
    reconcile_calls=$((reconcile_calls+1))
    printf '%s\n' '{"cliClientId":"cli-upgraded-42"}' >"$1"
    printf 'cli-upgraded-42\n' >"$1.cli-client-id"
  }
  rp_recover_zitadel_cli_client_state "$output"
  [[ "$RP_CFG_OIDC_CLI_CLIENT_ID" == cli-upgraded-42 ]]
  [[ "$reconcile_calls" == 1 ]]
  rp_recover_zitadel_cli_client_state "$output"
  [[ "$RP_CFG_OIDC_CLI_CLIENT_ID" == cli-upgraded-42 ]]
  [[ "$reconcile_calls" == 1 ]]
)
status 0 'legacy install idempotently reconciles missing CLI client id' legacy_install_reconciles_missing_cli_client

legacy_install_recovers_management_state() (
  output="$(mktemp /tmp/rp-zitadel-legacy.XXXXXX.json)"
  pat="$(mktemp /tmp/rp-zitadel-legacy-pat.XXXXXX)"
  trap 'rm -f "$output" "$pat"' EXIT
  printf '%s\n' '{"organizationId":"org-legacy","projectId":"project-legacy","clientSecret":"not-the-management-token"}' >"$output"
  printf 'legacy-first-instance-pat\n' >"$pat"
  unset RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  rp_ensure_versioned_swarm_secret(){
    [[ "$1" == rp_zitadel_management_token && "$2" == "$pat" ]] || return 1
    printf 'rp_zitadel_management_token_legacy42\n'
  }
  rp_recover_zitadel_management_state "$output" "$pat"
  [[ "$RP_CFG_ZITADEL_ORGANIZATION_ID" == org-legacy ]]
  [[ "$RP_CFG_ZITADEL_PROJECT_ID" == project-legacy ]]
  [[ "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" == rp_zitadel_management_token_legacy42 ]]
)
status 0 'legacy install recovers management state from JSON and FirstInstance PAT' legacy_install_recovers_management_state

resume_preserves_existing_management_state() (
  RP_CFG_ZITADEL_ORGANIZATION_ID='org-resume'
  RP_CFG_ZITADEL_PROJECT_ID='project-resume'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_resume42'
  export RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  rp_ensure_versioned_swarm_secret(){ return 99; }
  rp_recover_zitadel_management_state /does/not/exist /does/not/exist
  [[ "$RP_CFG_ZITADEL_ORGANIZATION_ID" == org-resume ]]
  [[ "$RP_CFG_ZITADEL_PROJECT_ID" == project-resume ]]
  [[ "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" == rp_zitadel_management_token_resume42 ]]
)
status 0 'resume preserves existing management metadata and secret ref' resume_preserves_existing_management_state

config_never_persists_management_pat() (
  cfg="$(mktemp /tmp/rp-zitadel-config.XXXXXX)"
  trap 'rm -f "$cfg"' EXIT
  RP_CFG_ZITADEL_ORGANIZATION_ID='org-config'
  RP_CFG_ZITADEL_PROJECT_ID='project-config'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_config42'
  ZITADEL_MANAGEMENT_TOKEN='plaintext-pat-must-not-persist'
  export RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF ZITADEL_MANAGEMENT_TOKEN
  rp_config_write "$cfg"
  text="$(cat "$cfg")"
  [[ "$text" == *'RP_CFG_ZITADEL_ORGANIZATION_ID=org-config'* ]]
  [[ "$text" == *'RP_CFG_ZITADEL_PROJECT_ID=project-config'* ]]
  [[ "$text" == *'RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF=rp_zitadel_management_token_config42'* ]]
  [[ "$text" != *plaintext-pat-must-not-persist* ]]
)
status 0 'installer config persists metadata/ref but never the PAT' config_never_persists_management_pat

repair_preserves_management_state() (
  log="$(mktemp /tmp/rp-zitadel-repair.XXXXXX)"; trap 'rm -f "$log"' EXIT
  RP_REPAIR_CONFIRMATION='REPAIR control-plane'
  RP_CFG_DOMAIN='rp.example.com'
  RP_CFG_ZITADEL_ORGANIZATION_ID='org-repair'
  RP_CFG_ZITADEL_PROJECT_ID='project-repair'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_repair42'
  export RP_REPAIR_CONFIRMATION RP_CFG_DOMAIN RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  rp_deploy_control_plane(){ [[ "$1" == final ]] && printf 'deploy:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_wait_for_https_origin(){ return 0; }
  rp_config_write(){ printf 'config:%s:%s:%s\n' "$RP_CFG_ZITADEL_ORGANIZATION_ID" "$RP_CFG_ZITADEL_PROJECT_ID" "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_write_stack(){ printf 'stack:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_run_repair control-plane
  text="$(cat "$log")"
  [[ "$text" == *'zitadel-upgrade'* ]]
  [[ "$text" == *'deploy:rp_zitadel_management_token_repair42'* ]]
  [[ "$text" == *'config:org-repair:project-repair:rp_zitadel_management_token_repair42'* ]]
  [[ "$text" == *'stack:rp_zitadel_management_token_repair42'* ]]
)
status 0 'repair redeploy and persist preserve management state' repair_preserves_management_state

reconfigure_preserves_management_state() (
  log="$(mktemp /tmp/rp-zitadel-reconfigure.XXXXXX)"; trap 'rm -f "$log"' EXIT
  RP_RECONFIGURE_SECRET_KIND=cookie
  RP_CFG_COOKIE_SWARM_REF='rp_cookie_secret_old'
  RP_CFG_DOMAIN='rp.example.com'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_reconfigure42'
  export RP_RECONFIGURE_SECRET_KIND RP_CFG_COOKIE_SWARM_REF RP_CFG_DOMAIN RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  rp_generate_secret_file(){ printf rotated-cookie >"$1"; }
  rp_ensure_versioned_swarm_secret(){ [[ "$1" == rp_cookie_secret ]] || return 1; printf 'rp_cookie_secret_new\n'; }
  rp_remove_secret_file(){ rm -f "$1"; }
  rp_deploy_control_plane(){ [[ "$1" == final ]] && printf 'deploy:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_wait_for_https_origin(){ return 0; }
  rp_config_write(){ printf 'config:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_write_stack(){ printf 'stack:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_reconfigure_rotate_secret
  text="$(cat "$log")"
  [[ "$text" == *'deploy:rp_zitadel_management_token_reconfigure42'* ]]
  [[ "$text" == *'config:rp_zitadel_management_token_reconfigure42'* ]]
)
status 0 'reconfigure preserves management secret ref' reconfigure_preserves_management_state


zitadel_public_config_is_content_addressed() (
  tmpdir="$(mktemp -d /tmp/rp-zitadel-public-config.XXXXXX)"; trap 'rm -rf "$tmpdir"' EXIT
  RP_CFG_ZITADEL_DOMAIN='auth.new.example.com'
  RP_ZITADEL_PUBLIC_CONFIG_PATH="$tmpdir/zitadel-config.yaml"
  export RP_CFG_ZITADEL_DOMAIN RP_ZITADEL_PUBLIC_CONFIG_PATH
  created=''
  docker() {
    if [[ "$1 $2" == 'config inspect' ]]; then return 1; fi
    if [[ "$1 $2" == 'config create' ]]; then created="$3:$4"; return 0; fi
    return 1
  }
  rp_prepare_zitadel_public_config
  expected_hash="$(sha256sum "$RP_ZITADEL_PUBLIC_CONFIG_PATH" | awk '{print substr($1,1,16)}')"
  [[ "$RP_CFG_ZITADEL_PUBLIC_CONFIG_REF" == "zitadel_public_config_${expected_hash}" ]]
  [[ "$created" == "zitadel_public_config_${expected_hash}:$RP_ZITADEL_PUBLIC_CONFIG_PATH" ]]
  grep -q '^ExternalDomain: auth.new.example.com$' "$RP_ZITADEL_PUBLIC_CONFIG_PATH"
)
status 0 'ZITADEL public config is content-addressed and tracks ExternalDomain' zitadel_public_config_is_content_addressed

reconfigure_domain_reconciles_oidc_before_final() (
  log="$(mktemp /tmp/rp-domain-reconfigure.XXXXXX)"; trap 'rm -f "$log"' EXIT
  RP_CFG_DOMAIN='old.example.com'
  RP_CFG_ZITADEL_DOMAIN='auth.old.example.com'
  RP_CFG_ACME_EMAIL='admin@example.com'
  RP_CFG_INGRESS_ADDRESSES='203.0.113.10'
  RP_CFG_ZITADEL_PUBLIC_CONFIG_REF='zitadel_public_config_old'
  export RP_CFG_DOMAIN RP_CFG_ZITADEL_DOMAIN RP_CFG_ACME_EMAIL RP_CFG_INGRESS_ADDRESSES RP_CFG_ZITADEL_PUBLIC_CONFIG_REF
  input_index=0
  rp_ui_input() {
    input_index=$((input_index+1))
    case "$input_index" in
      1) printf 'new.example.com\n' ;;
      2) printf 'auth.new.example.com\n' ;;
      3) printf 'new-admin@example.com\n' ;;
      4) printf '203.0.113.20\n' ;;
    esac
  }
  rp_primary_enable_ingress(){ RP_CFG_ZITADEL_PUBLIC_CONFIG_REF='zitadel_public_config_new'; export RP_CFG_ZITADEL_PUBLIC_CONFIG_REF; printf 'ingress:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; }
  rp_run_zitadel_web_oidc_reconcile(){ printf 'oidc:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; }
  rp_primary_deploy_final(){ printf 'final:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; }
  rp_primary_persist(){ printf 'persist:%s:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" "$RP_CFG_ZITADEL_PUBLIC_CONFIG_REF" >>"$log"; }
  rp_reconfigure_domain
  expected=$'ingress:new.example.com:auth.new.example.com\noidc:new.example.com:auth.new.example.com\nfinal:new.example.com:auth.new.example.com\npersist:new.example.com:auth.new.example.com:zitadel_public_config_new'
  [[ "$(cat "$log")" == "$expected" ]]
  [[ "$RP_CFG_LEGACY_DOMAIN" == old.example.com ]]
  [[ "$RP_CFG_LEGACY_ZITADEL_DOMAIN" == auth.old.example.com ]]
)
status 0 'domain reconfigure updates ZITADEL/OIDC before persisting final stack' reconfigure_domain_reconciles_oidc_before_final

reconfigure_domain_rolls_back_zitadel_and_oidc() (
  log="$(mktemp /tmp/rp-domain-rollback.XXXXXX)"; trap 'rm -f "$log"' EXIT
  RP_CFG_DOMAIN='old.example.com'
  RP_CFG_ZITADEL_DOMAIN='auth.old.example.com'
  RP_CFG_ACME_EMAIL='admin@example.com'
  RP_CFG_INGRESS_ADDRESSES='203.0.113.10'
  RP_CFG_ZITADEL_PUBLIC_CONFIG_REF='zitadel_public_config_old'
  export RP_CFG_DOMAIN RP_CFG_ZITADEL_DOMAIN RP_CFG_ACME_EMAIL RP_CFG_INGRESS_ADDRESSES RP_CFG_ZITADEL_PUBLIC_CONFIG_REF
  input_index=0
  oidc_calls=0
  rp_ui_input() {
    input_index=$((input_index+1))
    case "$input_index" in
      1) printf 'new.example.com\n' ;;
      2) printf 'auth.new.example.com\n' ;;
      3) printf 'new-admin@example.com\n' ;;
      4) printf '203.0.113.20\n' ;;
    esac
  }
  rp_primary_enable_ingress(){ RP_CFG_ZITADEL_PUBLIC_CONFIG_REF='zitadel_public_config_new'; export RP_CFG_ZITADEL_PUBLIC_CONFIG_REF; printf 'ingress:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; }
  rp_run_zitadel_web_oidc_reconcile(){ oidc_calls=$((oidc_calls+1)); printf 'oidc:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; }
  rp_primary_deploy_final(){ printf 'final-failed:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" >>"$log"; return 1; }
  rp_deploy_control_plane(){ printf 'rollback-stack:%s:%s:%s\n' "$RP_CFG_DOMAIN" "$RP_CFG_ZITADEL_DOMAIN" "$RP_CFG_ZITADEL_PUBLIC_CONFIG_REF" >>"$log"; }
  set +e
  rp_reconfigure_domain
  rc=$?
  set -e
  [[ "$rc" == 1 ]]
  [[ "$RP_CFG_DOMAIN" == old.example.com ]]
  [[ "$RP_CFG_ZITADEL_DOMAIN" == auth.old.example.com ]]
  [[ "$RP_CFG_ZITADEL_PUBLIC_CONFIG_REF" == zitadel_public_config_old ]]
  [[ "$(cat "$log")" == *'rollback-stack:old.example.com:auth.old.example.com:zitadel_public_config_old'* ]]
  [[ "$(cat "$log")" == *'oidc:old.example.com:auth.old.example.com'* ]]
)
status 0 'domain reconfigure rolls back ZITADEL config and OIDC client after final failure' reconfigure_domain_rolls_back_zitadel_and_oidc

upgrade_preserves_management_state() (
  previous="$(mktemp /tmp/rp-zitadel-upgrade-stack.XXXXXX.yml)"; manifest="$(mktemp /tmp/rp-zitadel-upgrade-manifest.XXXXXX.json)"; log="$(mktemp /tmp/rp-zitadel-upgrade.XXXXXX)"
  trap 'rm -f "$previous" "$manifest" "$log"' EXIT
  printf 'version: "3.9"\n' >"$previous"
  printf '%s\n' '{"version":"0.1.4"}' >"$manifest"
  RP_CFG_DOMAIN='rp.example.com'
  RP_CFG_RELEASE_VERSION='0.2.9'
  RP_CFG_ZITADEL_ORGANIZATION_ID='org-upgrade'
  RP_CFG_ZITADEL_PROJECT_ID='project-upgrade'
  RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF='rp_zitadel_management_token_upgrade42'
  export RP_CFG_DOMAIN RP_CFG_RELEASE_VERSION RP_CFG_ZITADEL_ORGANIZATION_ID RP_CFG_ZITADEL_PROJECT_ID RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF
  rp_pull_release_images(){ return 0; }
  rp_apply_release_manifest_images(){ return 0; }
  rp_upgrade_quiesce_database_clients(){ return 0; }
  rp_upgrade_prepare_postgres_services(){ return 0; }
  rp_upgrade_prepare_zitadel_for_mcp_oauth(){ printf 'zitadel-source:%s\n' "$1" >>"$log"; }
  rp_run_zitadel_mcp_oauth_reconcile(){ printf 'mcp-oauth:%s
' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_run_migrations(){ return 0; }
  rp_deploy_control_plane(){ [[ "$1" == final ]] && printf 'deploy:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_wait_for_https_origin(){ return 0; }
  rp_primary_start_enrollment(){ printf 'enrollment:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_persist_release_manifest(){ printf '%s\n' "$1"; }
  rp_manifest_value(){ [[ "$2" == .version ]] && printf '0.1.4\n'; }
  rp_config_write(){ printf 'config:%s:%s:%s\n' "$RP_CFG_ZITADEL_ORGANIZATION_ID" "$RP_CFG_ZITADEL_PROJECT_ID" "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_write_stack(){ printf 'stack:%s\n' "$RP_CFG_ZITADEL_MANAGEMENT_SWARM_REF" >>"$log"; }
  rp_upgrade_apply "$manifest" "$previous"
  text="$(cat "$log")"
  [[ "$text" == *'zitadel-source:0.2.9'* ]]
  [[ "$text" == *'mcp-oauth:rp_zitadel_management_token_upgrade42'* ]]
  [[ "$text" == *'deploy:rp_zitadel_management_token_upgrade42'* ]]
  [[ "$text" == *'enrollment:rp_zitadel_management_token_upgrade42'* ]]
  [[ "$text" == *'config:org-upgrade:project-upgrade:rp_zitadel_management_token_upgrade42'* ]]
  [[ "$text" == *'stack:rp_zitadel_management_token_upgrade42'* ]]
)
status 0 'upgrade preserves and persists management state' upgrade_preserves_management_state

upgrade_bridges_legacy_zitadel_before_target() (
  log="$(mktemp /tmp/rp-zitadel-upgrade-image.XXXXXX)"
  state="$(mktemp /tmp/rp-zitadel-upgrade-state.XXXXXX)"
  trap 'rm -f "$log" "$state"' EXIT
  old='ghcr.io/zitadel/zitadel@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  bridge="$(rp_upgrade_zitadel_migration_bridge_image)"
  target='ghcr.io/zitadel/zitadel@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  printf '%s\n' "$old" >"$state"
  RP_CFG_STACK_NAME='resourceportal-control-plane'
  RP_CFG_RELEASE_VERSION='0.2.9'
  RP_CFG_ZITADEL_IMAGE="$target"
  RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS=2
  export RP_CFG_STACK_NAME RP_CFG_RELEASE_VERSION RP_CFG_ZITADEL_IMAGE RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS
  docker(){
    case "$1 $2" in
      'service inspect')
        if [[ "$*" == *'.Spec.Mode.Replicated'* ]]; then printf 'replicated\n';
        elif [[ "$*" == *'--format'* ]]; then cat "$state"; fi
        return 0
        ;;
      'service update')
        printf '%s\n' "$*" >>"$log"
        while (( $# > 0 )); do
          if [[ "$1" == --image ]]; then printf '%s\n' "$2" >"$state"; break; fi
          shift
        done
        return 0
        ;;
      'service ps') printf 'Running 1 second ago\n'; return 0 ;;
      pull\ *) printf '%s\n' "$*" >>"$log"; return 0 ;;
      *) return 0 ;;
    esac
  }
  rp_upgrade_prepare_zitadel_for_mcp_oauth
  bridge_line="$(grep -nF "service update --detach=false --image $bridge" "$log" | cut -d: -f1)"
  target_line="$(grep -nF "service update --detach=false --image $target" "$log" | cut -d: -f1)"
  [[ -n "$bridge_line" && -n "$target_line" && "$bridge_line" -lt "$target_line" ]]
)
status 0 'legacy upgrade bridges ZITADEL v4.15.1 before target digest' upgrade_bridges_legacy_zitadel_before_target

upgrade_skips_bridge_for_v0212_and_newer() (
  log="$(mktemp /tmp/rp-zitadel-upgrade-image-new.XXXXXX)"
  state="$(mktemp /tmp/rp-zitadel-upgrade-state-new.XXXXXX)"
  trap 'rm -f "$log" "$state"' EXIT
  old='ghcr.io/zitadel/zitadel@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  target='ghcr.io/zitadel/zitadel@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  bridge="$(rp_upgrade_zitadel_migration_bridge_image)"
  printf '%s\n' "$old" >"$state"
  RP_CFG_STACK_NAME='resourceportal-control-plane'
  RP_CFG_RELEASE_VERSION='0.2.13'
  RP_CFG_ZITADEL_IMAGE="$target"
  RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS=2
  export RP_CFG_STACK_NAME RP_CFG_RELEASE_VERSION RP_CFG_ZITADEL_IMAGE RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS
  docker(){
    case "$1 $2" in
      'service inspect')
        if [[ "$*" == *'.Spec.Mode.Replicated'* ]]; then printf 'replicated\n';
        elif [[ "$*" == *'--format'* ]]; then cat "$state"; fi
        return 0
        ;;
      'service update')
        printf '%s\n' "$*" >>"$log"
        while (( $# > 0 )); do
          if [[ "$1" == --image ]]; then printf '%s\n' "$2" >"$state"; break; fi
          shift
        done
        return 0
        ;;
      'service ps') printf 'Running 1 second ago\n'; return 0 ;;
      pull\ *) printf '%s\n' "$*" >>"$log"; return 0 ;;
      *) return 0 ;;
    esac
  }
  rp_upgrade_prepare_zitadel_for_mcp_oauth
  text="$(cat "$log")"
  [[ "$text" == *"service update --detach=false --image $target"* ]]
  [[ "$text" != *"$bridge"* ]]
)
status 0 'v0.2.12+ upgrade skips legacy ZITADEL bridge' upgrade_skips_bridge_for_v0212_and_newer
mcp_oauth_reconcile_uses_swarm_safe_service_name() (
  pat="$(mktemp /tmp/rp-zitadel-mcp-pat.XXXXXX)"
  log="$(mktemp /tmp/rp-zitadel-mcp-service.XXXXXX)"
  trap 'rm -f "$pat" "$log"' EXIT
  printf 'management-token-material\n' >"$pat"
  chmod 0600 "$pat"
  RP_ZITADEL_MANAGEMENT_PAT_FILE="$pat"
  RP_CFG_STACK_NAME='resourceportal-control-plane'
  RP_CFG_ZITADEL_DOMAIN='auth.example.test'
  RP_CFG_API_IMAGE='example.invalid/resourceportal-api@sha256:deadbeef'
  RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS=2
  export RP_ZITADEL_MANAGEMENT_PAT_FILE RP_CFG_STACK_NAME RP_CFG_ZITADEL_DOMAIN RP_CFG_API_IMAGE RP_IDENTITY_BOOTSTRAP_TIMEOUT_SECONDS
  rp_zitadel_management_state_ready(){ return 0; }
  date(){ printf '1790160000\n'; }
  docker(){
    case "$1 $2" in
      'service create')
        shift 2
        while (( $# > 0 )); do
          if [[ "$1" == --name ]]; then printf '%s\n' "$2" >"$log"; break; fi
          shift
        done
        return 0
        ;;
      'service ps') printf 'Complete 1 second ago|\n' ;;
      'service rm') return 0 ;;
      *) return 0 ;;
    esac
  }
  rp_run_zitadel_mcp_oauth_reconcile
  name="$(cat "$log")"
  [[ "$name" == 'resourceportal-control-plane-zitadel-mcp-oauth-1790160000' ]]
  (( ${#name} <= 63 ))
)
status 0 'MCP OAuth reconcile service name stays within Swarm limit' mcp_oauth_reconcile_uses_swarm_safe_service_name

status 0 'management secret is classified as ResourcePortal-owned' rp_swarm_resourceportal_secret_name rp_zitadel_management_token_deadbeef

factory_cleanup_removes_management_secret() (
  log="$(mktemp /tmp/rp-zitadel-reset.XXXXXX)"; trap 'rm -f "$log"' EXIT
  rp_reset_swarm_active(){ return 0; }
  docker(){
    case "$1 $2" in
      'secret ls') printf '%s\n' rp_zitadel_management_token_deadbeef unrelated_secret ;;
      'secret rm') printf 'rm:%s\n' "$3" >>"$log" ;;
      'config ls') return 0 ;;
      *) return 0 ;;
    esac
  }
  rp_reset_remove_swarm_resources
  [[ "$(cat "$log")" == *'rm:rp_zitadel_management_token_deadbeef'* ]]
  [[ "$(cat "$log")" != *unrelated_secret* ]]
)
status 0 'factory cleanup removes management secret and preserves unrelated secrets' factory_cleanup_removes_management_secret

if (( failures > 0 )); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All ZITADEL management installer regression tests passed.\n'