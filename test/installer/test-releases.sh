#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
status(){ local e="$1" n="$2"; shift 2; set +e; "$@" >/tmp/rp-release.out 2>/tmp/rp-release.err; local a=$?; set -e; [[ "$a" == "$e" ]] && pass "$n" || fail "$n"; }
eq(){ [[ "$1" == "$2" ]] && pass "$3" || { printf 'expected=%s actual=%s\n' "$1" "$2" >&2; fail "$3"; }; }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3"; }

manifest="$(mktemp /tmp/rp-release.XXXXXX.json)"
cat >"$manifest" <<'JSON'
{
  "schemaVersion": 1,
  "version": "0.2.0",
  "installer": {"minimumVersion": "0.1.0"},
  "docker": {"minimumVersion": "27.0.0"},
  "configSchemaVersion": 1,
  "images": {
    "api": "ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "web": "ghcr.io/re-invertion/resourceportal-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "postgres": "ghcr.io/re-invertion/resourceportal-postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "zitadel": "ghcr.io/zitadel/zitadel@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "traefik": "traefik@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "migrations": {
    "supportedFromVersions": ["0.1.0"],
    "rollbackPolicy": "none"
  }
}
JSON

# The updater is based on Alpine: BusyBox mktemp requires XXXXXX at the end
# of a supplied template. GNU mktemp accepts the old .XXXXXX.yml/.json form,
# so run a compatibility scan even on Ubuntu CI runners.
busybox_mktemp_templates_valid() {
  local file
  while IFS= read -r file; do
    if grep -nE 'mktemp[[:space:]][^)]*XXXXXX\.[[:alnum:]]+' "$file"; then
      printf 'BusyBox-incompatible mktemp template in %s\n' "$file" >&2
      return 1
    fi
  done < <(find "$repo_root/scripts/installer" -name '*.sh' -type f)
}
status 0 'installer mktemp templates support Alpine BusyBox' busybox_mktemp_templates_valid
status 0 'upgrade preflight can create a runtime temporary file' rp_upgrade_check_temporary_files
recovery_source="$(cat "$repo_root/scripts/upgrade-recovery-from-0.2.68.sh")"
contains "$recovery_source" 'docker pull "$image"' 'legacy recovery pulls target immutable API image'
contains "$recovery_source" '"$image" /bin/bash /app/resourceportal-installer/resourceportal-install.sh' 'legacy recovery boots fixed target installer, never installed v0.2.68 image'
contains "$recovery_source" 'resourceportal.updater=true' 'legacy recovery participates in updater concurrency guard'
contains "$recovery_source" 'docker wait "$container"' 'legacy recovery observes detached installer result'


upgrade_temp_fail_closed() (
  mktemp() { printf 'simulated mktemp error\n' >&2; return 1; }
  # Critical dependencies must not be quiesced if runtime temp files fail.
  rp_upgrade_quiesce_database_clients() {
    printf 'unsafe: quiesced services before temp preflight\n' >&2
    return 0
  }
  rp_upgrade_apply "$manifest" "$manifest"
)
status 1 'upgrade aborts before changing running services if mktemp fails' upgrade_temp_fail_closed

status 0 'valid release manifest accepted' rp_validate_release_manifest "$manifest"
eq '0.2.0' "$(rp_manifest_value "$manifest" '.version')" 'reads release version'

pull_release_images_reuses_local_digest() (
  local calls
  calls="$(mktemp)"
  trap 'rm -f "$calls"' EXIT
  docker() {
    if [[ "$1" == image && "$2" == inspect ]]; then
      [[ "$3" == traefik@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ]]
      return
    fi
    if [[ "$1" == pull ]]; then
      printf '%s\n' "$2" >>"$calls"
      return 0
    fi
    return 1
  }
  rp_pull_release_images "$manifest" || return 1
  grep -Fq 'ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "$calls" || return 1
  ! grep -Fq 'traefik@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' "$calls"
)
status 0 'upgrade reuses an exact local release digest instead of pulling it again' pull_release_images_reuses_local_digest

persist_state="$(mktemp -d /tmp/rp-release-state.XXXXXX)"
RP_INSTALLER_STATE_DIR="$persist_state"
export RP_INSTALLER_STATE_DIR
persisted_manifest="$(rp_persist_release_manifest "$manifest")"
eq "$persist_state/release.json" "$persisted_manifest" 'canonical release manifest uses installer-state path'
status 0 'canonical release manifest remains valid' rp_validate_release_manifest "$persisted_manifest"
eq '0.2.0' "$(rp_manifest_value "$persisted_manifest" '.version')" 'canonical release manifest preserves version'
cmp -s "$manifest" "$persisted_manifest" && pass 'canonical release manifest preserves exact content' || fail 'canonical release manifest preserves exact content'
rm -rf "$persist_state"
unset RP_INSTALLER_STATE_DIR persisted_manifest persist_state
eq '27.0.0' "$(rp_manifest_value "$manifest" '.docker.minimumVersion')" 'reads minimum Docker version'

# Primary installs should resolve the newest stable release automatically.
rp_list_stable_releases() { printf 'v0.2.0\nv0.1.0\n'; }
eq '0.2.0' "$(rp_detect_latest_stable_release)" 'detects latest stable release without v prefix'
rp_list_stable_releases() { :; }
status 1 'fails clearly when no stable release exists' rp_detect_latest_stable_release

# Primary release resolution auto-selects latest stable when no version is pinned.
auto_manifest="$(mktemp /tmp/rp-release-auto.XXXXXX.json)"
rm -f "$auto_manifest"
requested_version="$(mktemp /tmp/rp-release-requested.XXXXXX)"
rp_detect_latest_stable_release() { printf '0.2.0\n'; }
source_manifest="$manifest"
rp_download_release_manifest() { printf '%s\n' "$1" >"$requested_version"; cp "$source_manifest" "$2"; }
docker() { [[ "$1" == version ]] && printf '29.0.0\n'; }
unset RP_CFG_RELEASE_VERSION
export RP_CFG_RELEASE_MANIFEST="$auto_manifest" RP_CFG_INSTALLED_VERSION=0.1.0 RP_INSTALLER_VERSION=0.1.0
status 0 'primary resolves release automatically' rp_primary_resolve_release
eq '0.2.0' "$(cat "$requested_version")" 'primary downloads latest stable release manifest'
rm -f "$auto_manifest" "$requested_version"

# Fresh Primary installation has no installed release yet, so migration source compatibility
# must not reject the initial release manifest.
fresh_manifest="$(mktemp /tmp/rp-release-fresh.XXXXXX.json)"
rm -f "$fresh_manifest"
rp_detect_latest_stable_release() { printf '0.2.0\n'; }
rp_download_release_manifest() { cp "$source_manifest" "$2"; }
unset RP_CFG_RELEASE_VERSION
export RP_CFG_RELEASE_MANIFEST="$fresh_manifest" RP_CFG_INSTALLED_VERSION=0.0.0 RP_INSTALLER_VERSION=0.1.0
status 0 'fresh primary accepts initial release without upgrade source match' rp_primary_resolve_release
rm -f "$fresh_manifest"

# A stale/nonexistent persisted release from older installer prompts should recover to latest stable.
stale_manifest="$(mktemp /tmp/rp-release-stale.XXXXXX.json)"
rm -f "$stale_manifest"
stale_requests="$(mktemp /tmp/rp-release-stale-requests.XXXXXX)"
: >"$stale_requests"
rp_detect_latest_stable_release() { printf '0.2.0\n'; }
rp_download_release_manifest() {
  printf '%s\n' "$1" >>"$stale_requests"
  [[ "$1" == 0.2.0 ]] || return 1
  cp "$source_manifest" "$2"
}
export RP_CFG_RELEASE_VERSION=1.0.0 RP_CFG_RELEASE_MANIFEST="$stale_manifest" RP_CFG_INSTALLED_VERSION=0.1.0
status 0 'primary recovers stale persisted release to latest stable' rp_primary_resolve_release
eq $'1.0.0\n0.2.0' "$(cat "$stale_requests")" 'primary retries stale release with latest stable'
eq '0.2.0' "$RP_CFG_RELEASE_VERSION" 'primary replaces stale release version after successful fallback'
rm -f "$stale_manifest" "$stale_requests"
status 0 'fresh install accepts release without migration source match' rp_release_install_compatible "$manifest" '0.1.0' '28.0.0'
status 0 'compatible installer accepted' rp_release_compatible "$manifest" '0.1.0' '0.1.0' '28.0.0'
status 1 'old installer rejected' rp_release_compatible "$manifest" '0.0.9' '0.1.0' '28.0.0'
status 1 'unsupported current release rejected' rp_release_compatible "$manifest" '0.1.0' '0.0.8' '28.0.0'
status 1 'old Docker rejected' rp_release_compatible "$manifest" '0.1.0' '0.1.0' '26.1.0'

# v0.2.0 explicitly supports the production source versions from the v0.1 line.
v020_manifest="$(mktemp /tmp/rp-release-v020.XXXXXX.json)"
jq '.migrations.supportedFromVersions=["0.1.8","0.1.9","0.1.10"]' "$manifest" >"$v020_manifest"
status 0 'v0.2 accepts upgrade from v0.1.8' rp_release_compatible "$v020_manifest" '0.1.0' '0.1.8' '28.0.0'
status 0 'v0.2 accepts upgrade from v0.1.9' rp_release_compatible "$v020_manifest" '0.1.0' '0.1.9' '28.0.0'
status 0 'v0.2 accepts upgrade from v0.1.10' rp_release_compatible "$v020_manifest" '0.1.0' '0.1.10' '28.0.0'
status 1 'v0.2 rejects source older than supported floor' rp_release_compatible "$v020_manifest" '0.1.0' '0.1.7' '28.0.0'
rm -f "$v020_manifest"
status 1 'irreversible migration refuses automatic rollback' rp_upgrade_rollback_allowed "$manifest"

safe_manifest="$(mktemp /tmp/rp-release-safe.XXXXXX.json)"
sed 's/"rollbackPolicy": "none"/"rollbackPolicy": "image-only"/' "$manifest" >"$safe_manifest"
status 0 'explicit image-only compatibility allows rollback' rp_upgrade_rollback_allowed "$safe_manifest"
upgrade_automatic_recovery_smoke() (
  local log
  log="$(mktemp /tmp/rp-rollback-smoke.XXXXXX)"
  trap 'rm -f "$log"' EXIT
  RP_CFG_DOMAIN=rp.example.test
  docker(){ printf 'docker:%s\n' "$*" >>"$log"; return 0; }
  rp_wait_for_https_origin(){ printf 'healthy:%s\n' "$1" >>"$log"; return 0; }
  rp_upgrade_restore_after_failure "$safe_manifest" "$manifest" "injected upgrade failure" || true
  grep -q 'docker:stack deploy' "$log" && grep -q 'healthy:rp.example.test' "$log"
)
status 0 'compatible failed upgrade restores previous stack and verifies health' upgrade_automatic_recovery_smoke

upgrade_rollback_denied_smoke() (
  local log
  log="$(mktemp /tmp/rp-rollback-refused.XXXXXX)"
  trap 'rm -f "$log"' EXIT
  docker(){ printf 'unsafe rollback\n' >>"$log"; return 0; }
  rp_upgrade_restore_after_failure "$manifest" "$manifest" "injected incompatible migration" || true
  [[ ! -s "$log" ]]
)
status 0 'incompatible failed upgrade does not deploy previous stack' upgrade_rollback_denied_smoke


mutable="$(mktemp /tmp/rp-release-mutable.XXXXXX.json)"
sed 's#ghcr.io/re-invertion/resourceportal-api@sha256:[a-f]*#ghcr.io/re-invertion/resourceportal-api:latest#' "$manifest" >"$mutable"
status 1 'mutable latest image rejected' rp_validate_release_manifest "$mutable"

arbitrary_publisher="$(mktemp /tmp/rp-release-evil.XXXXXX.json)"
sed 's#ghcr.io/re-invertion/resourceportal-api@#ghcr.io/attacker/payload@#' "$manifest" >"$arbitrary_publisher"
status 1 'arbitrary image publisher is rejected even with immutable digest' rp_validate_release_manifest "$arbitrary_publisher"
rm -f "$arbitrary_publisher"


workflow="$(cat "$repo_root/.github/workflows/release.yml")"
contains "$workflow" 'packages: write' 'release workflow can publish GHCR'
contains "$workflow" 'branches: [main]' 'release workflow automatically publishes every main merge'
contains "$workflow" '--target "$GITHUB_SHA"' 'release workflow pins tag to the validated main revision'
not_contains "$workflow" 'workflow_dispatch:' 'release workflow cannot be manually dispatched'
contains "$workflow" 'steps.version.outputs.tag' 'release workflow uses validated release tag for image publication'
contains "$workflow" 'docker/build-push-action' 'release workflow builds immutable images'
contains "$workflow" 'ghcr.io/${{ github.repository_owner }}/resourceportal-postgres:${{ steps.version.outputs.tag }}' 'release workflow publishes fenced PostgreSQL image'
for dockerfile in "$repo_root/Dockerfile" "$repo_root/packages/resourceportal-web/Dockerfile" "$repo_root/packages/resourceportal-postgres/Dockerfile"; do
  contains "$(cat "$dockerfile")" 'org.opencontainers.image.source="https://github.com/re-invertion/resourcePortal"' "release image links to public source repository: ${dockerfile#$repo_root/}"
done
contains "$workflow" 'docker logout ghcr.io' 'release workflow drops GHCR credentials before public pull verification'
contains "$workflow" 'docker buildx imagetools inspect' 'release workflow verifies anonymous exact-digest pulls'
contains "$workflow" 'resourceportal-release-manifest.json' 'release workflow publishes machine-readable manifest'
not_contains "$workflow" 'supportedFromVersions:["0.1.0"]' 'release workflow does not hardcode a single migration source'
contains "$workflow" 'fetch-depth: 0' 'release workflow fetches tag history for compatibility derivation'
contains "$workflow" 'git tag --merged HEAD' 'release workflow derives compatibility only from ancestor release tags'
contains "$workflow" 'SUPPORTED_FROM_VERSIONS' 'release workflow derives supported source versions dynamically'
contains "$workflow" 'supportedFromVersions:$supported_from_versions' 'release manifest uses derived supported source versions'
contains "$workflow" 'MIN_SUPPORTED_SOURCE_VERSION: "0.1.8"' 'v0.2 release workflow keeps v0.1.8+ as supported upgrade sources'
not_contains "$workflow" 'release_series=' 'release workflow does not incorrectly restrict compatibility to the target minor series'
not_contains "$workflow" ':latest' 'release workflow never publishes latest tag'

schema="$(cat "$repo_root/config/production/release-manifest.schema.json")"
contains "$schema" 'rollbackPolicy' 'manifest schema declares rollback policy'
contains "$schema" 'minimumVersion' 'manifest schema declares installer compatibility'

# Stateful upgrade checkpoint regression: the previous stack/configuration
# must survive failure, and unsafe/interrupted operations must fail closed.
upgrade_checkpoint_recovers_previous_state() (
  local root previous original
  root="$(mktemp -d /tmp/rp-safe-recovery.XXXXXX)"
  trap 'rm -rf "$root"' EXIT
  previous="$root/old-stack.yml"
  printf 'services: {api: {image: old}}\n' >"$previous"
  install -d -m 0700 "$root/installed" "$root/config"
  cp "$manifest" "$root/installed/release.json"
  printf 'old-config\n' >"$root/config/installer.conf"
  printf 'old-installed-stack\n' >"$root/config/stack.yml"
  export RP_UPGRADE_STATE_DIR="$root/checkpoint"
  export RP_INSTALLER_STATE_DIR="$root/installed"
  export RP_UPGRADE_INSTALLER_CONFIG_FILE="$root/config/installer.conf"
  export RP_UPGRADE_STACK_FILE="$root/config/stack.yml"
  export RP_CFG_RELEASE_VERSION=0.1.0 RP_CFG_DOMAIN=rp.example.test
  RP_UPGRADE_SOURCE_VERSION=0.1.0
  export RP_UPGRADE_SOURCE_VERSION
  rp_upgrade_checkpoint_prepare "$safe_manifest" "$previous" 0.1.0 || return 1
  [[ "$(jq -r .phase "$root/checkpoint/state.json")" == prepared ]] || return 1
  [[ "$(stat -c %a "$root/checkpoint/state.json")" == 600 ]] || return 1
  original="$(sha256sum "$root/checkpoint/previous-stack.yml" | cut -d' ' -f1)"
  [[ "$original" == "$(jq -r .previousStackSha256 "$root/checkpoint/state.json")" ]] || return 1
  # Mutate both installed files as the failed updater could have done.
  printf 'incomplete-new-config\n' >"$root/config/installer.conf"
  printf 'incomplete-new-stack\n' >"$root/config/stack.yml"
  printf 'fake-new-manifest\n' >"$root/installed/release.json"
  rp_upgrade_checkpoint_phase applying "inject failure" || return 1
  local restored="$root/restored"
  docker() { [[ "$1 $2" == "stack deploy" ]] || return 1; printf '%s\n' "$*" >"$restored"; }
  rp_wait_for_https_origin() { return 0; }
  rp_upgrade_restore_after_failure "$safe_manifest" "$previous" "injected failure" && return 1
  [[ -r "$restored" && "$(jq -r .phase "$root/checkpoint/state.json")" == rolled-back ]] || return 1
  cmp -s "$manifest" "$root/installed/release.json" || return 1
  [[ "$(cat "$root/config/installer.conf")" == old-config ]] || return 1
  [[ "$(cat "$root/config/stack.yml")" == old-installed-stack ]] || return 1
  # Successful verified rollback releases the upgrade lock before a new attempt.
  # The journal permits a new update only after successful verified recovery.
  rp_upgrade_checkpoint_prepare "$safe_manifest" "$previous" 0.1.0 || return 1
  rp_upgrade_checkpoint_phase applying "incomplete" || return 1
  if rp_upgrade_checkpoint_prepare "$safe_manifest" "$previous" 0.1.0; then
    printf 'Unsafe continuation of interrupted update\n' >&2
    return 1
  fi
)
status 0 'upgrade checkpoint survives failure and prevents blind restart' upgrade_checkpoint_recovers_previous_state

upgrade_checkpoint_denies_tampering() (
  local root previous
  root="$(mktemp -d /tmp/rp-safe-tamper.XXXXXX)"
  trap 'rm -rf "$root"' EXIT
  previous="$root/old.yml"
  printf 'services: {}\n' >"$previous"
  export RP_UPGRADE_STATE_DIR="$root/checkpoint"
  export RP_INSTALLER_STATE_DIR="$root/installed"
  export RP_UPGRADE_INSTALLER_CONFIG_FILE="$root/installed/installer.conf"
  export RP_UPGRADE_STACK_FILE="$root/installed/stack.yml"
  export RP_CFG_RELEASE_VERSION=0.1.0 RP_CFG_DOMAIN=rp.example.test
  RP_UPGRADE_SOURCE_VERSION=0.1.0
  export RP_UPGRADE_SOURCE_VERSION
  rp_upgrade_checkpoint_prepare "$safe_manifest" "$previous" 0.1.0 || return 1
  printf 'tampered\n' >"$root/checkpoint/previous-stack.yml"
  docker() { printf 'INVALID deployment attempted\n' >&2; return 0; }
  rp_wait_for_https_origin() { return 0; }
  rp_upgrade_restore_after_failure "$safe_manifest" "$previous" "tampered" && return 1
  [[ "$(jq -r .phase "$root/checkpoint/state.json")" == rollback-failed ]]
)
status 0 'tampered checkpoint never restores prior stack' upgrade_checkpoint_denies_tampering

upgrade_policy_blocks_cross_version_automatic_rollback() (
  local strict
  strict="$(mktemp /tmp/rp-safe-source-policy.XXXXXX)"
  trap 'rm -f "$strict"' EXIT
  jq '.migrations.rollbackPolicy="image-only" | .migrations.rollbackAssessment={reason:"no-resourceportal-database-schema-changes",sourceVersion:"0.2.75",targetCommit:("a"*40)}' "$manifest" >"$strict"
  rp_validate_release_manifest "$strict" || return 1
  RP_UPGRADE_SOURCE_VERSION=0.2.74 rp_upgrade_rollback_allowed "$strict" && return 1
  RP_UPGRADE_SOURCE_VERSION=0.2.75 rp_upgrade_rollback_allowed "$strict"
)
status 0 'assessment restricts automatic rollback to tested source version' upgrade_policy_blocks_cross_version_automatic_rollback

upgrade_policy_rejects_unsupported_tested_claim() (
  local forged
  forged="$(mktemp /tmp/rp-forged-tested.XXXXXX)"
  trap 'rm -f "$forged"' EXIT
  jq '.migrations.rollbackPolicy="tested"' "$manifest" >"$forged"
  ! rp_validate_release_manifest "$forged"
)
status 0 'tested policy requires explicit integration evidence' upgrade_policy_rejects_unsupported_tested_claim

rm -f "$manifest" "$safe_manifest" "$mutable"

upgrade_source="$(cat "$repo_root/scripts/installer/upgrade.sh")"
contains "$upgrade_source" 'rp_wait_for_https_origin' 'upgrade verifies ResourcePortal health after deploy'
contains "$upgrade_source" 'rp_config_write' 'upgrade persists release state only after successful health check'
contains "$upgrade_source" 'RP_CFG_RELEASE_VERSION=' 'upgrade records selected release version'
contains "$upgrade_source" 'RP_CFG_RELEASE_MANIFEST="$canonical_manifest"' 'upgrade records the canonical applied release manifest for resume'
contains "$upgrade_source" '--with-registry-auth --prune' 'rollback prunes services from failed target architecture'
contains "$upgrade_source" 'rp_upgrade_ensure_v020_node_labels' 'v0.2 upgrade backfills node roles before deploy'
contains "$upgrade_source" 'rp_upgrade_prepare_zitadel_for_mcp_oauth' 'upgrade updates ZITADEL before MCP OAuth reconciliation'
contains "$upgrade_source" 'rp_upgrade_zitadel_migration_bridge_image' 'upgrade includes immutable ZITADEL migration bridge for legacy releases'
contains "$upgrade_source" '0d88e6e92d0bd98641c107a054715ca57cbd68ca2119d3600cfe95aa6ccc7be4' 'legacy ZITADEL bridge is pinned by digest'
contains "$upgrade_source" 'rp_run_zitadel_mcp_oauth_reconcile' 'upgrade reconciles automatic MCP OAuth registration before final deploy'
contains "$upgrade_source" 'rp_upgrade_refresh_enrollment_listener' 'upgrade refreshes standalone enrollment listener before persisting release state'
contains "$upgrade_source" 'rp_primary_start_enrollment' 'upgrade reuses the hardened primary enrollment listener lifecycle'
contains "$upgrade_source" 'case "$current" in' 'upgrade preserves explicit tenant-workloads false opt-out'
contains "$upgrade_source" 'rp_upgrade_prepare_postgres_services' 'upgrade pre-rolls PostgreSQL before dependent services'
contains "$(cat "$repo_root/Dockerfile")" '    flock \' 'runtime installer image includes flock for upgrade locking'
contains "$upgrade_source" 'rp_upgrade_quiesce_database_clients' 'upgrade quiesces old database clients before PostgreSQL rollout'


upgrade_quiesces_database_clients_before_postgres() (
  local log stack
  log="$(mktemp /tmp/rp-upgrade-quiesce.XXXXXX)"
  trap 'rm -f "$log"' EXIT
  stack='resourceportal-control-plane'
  RP_CFG_STACK_NAME="$stack"
  export RP_CFG_STACK_NAME
  docker() {
    case "$1 $2" in
      'service inspect')
        if [[ "$*" == *'.Spec.Mode.Replicated'* ]]; then printf 'replicated\n'; fi
        return 0
        ;;
      'service update')
        local replicas='' service="${*: -1}"
        while (( $# > 0 )); do
          if [[ "$1" == --replicas ]]; then replicas="$2"; shift 2; continue; fi
          shift
        done
        printf 'scale:%s:%s\n' "$service" "$replicas" >>"$log"
        ;;
      'service rm') printf 'rm:%s\n' "$3" >>"$log" ;;
      *) return 0 ;;
    esac
  }
  rp_upgrade_quiesce_database_clients
  expected=$'scale:resourceportal-control-plane_api:0\nscale:resourceportal-control-plane_worker:0\nscale:resourceportal-control-plane_dr-reconciliation:0\nscale:resourceportal-control-plane_zitadel:0\nrm:resourceportal-control-plane_egress-guard\nrm:resourceportal-control-plane-installer-enrollment'
  [[ "$(cat "$log")" == "$expected" ]]
)
status 0 'upgrade quiesces old DB clients before database rollout' upgrade_quiesces_database_clients_before_postgres

upgrade_prerolls_postgres_before_dependents() (
  local log target old stack
  log="$(mktemp /tmp/rp-upgrade-postgres-order.XXXXXX)"
  trap 'rm -f "$log"' EXIT
  target='ghcr.io/re-invertion/resourceportal-postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  old='ghcr.io/re-invertion/resourceportal-postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  stack='resourceportal-control-plane'
  declare -A images=(
    ["${stack}_postgres-rp"]="$old"
    ["${stack}_postgres-zitadel"]="$old"
  )
  RP_CFG_STACK_NAME="$stack"
  RP_CFG_POSTGRES_IMAGE="$target"
  RP_UPGRADE_SERVICE_TIMEOUT_SECONDS=2
  export RP_CFG_STACK_NAME RP_CFG_POSTGRES_IMAGE RP_UPGRADE_SERVICE_TIMEOUT_SECONDS
  rp_validate_image_ref(){ return 0; }
  docker() {
    case "$1 $2" in
      'service inspect') printf '%s\n' "${images[$3]}" ;;
      'service update')
        local image='' service="${*: -1}"
        shift 2
        while (( $# > 0 )); do
          if [[ "$1" == --image ]]; then image="$2"; shift 2; continue; fi
          shift
        done
        printf 'update:%s:%s\n' "$service" "$image" >>"$log"
        images["$service"]="$image"
        ;;
      'service ps') printf 'Running 1 second ago\n' ;;
      *) return 0 ;;
    esac
  }
  rp_upgrade_prepare_postgres_services
  mapfile -t updates <"$log"
  [[ "${updates[0]}" == "update:${stack}_postgres-rp:${target}" ]]
  [[ "${updates[1]}" == "update:${stack}_postgres-zitadel:${target}" ]]
  [[ "${#updates[@]}" == 2 ]]
)
status 0 'upgrade pre-rolls both PostgreSQL services in deterministic order' upgrade_prerolls_postgres_before_dependents

upgrade_orders_dependencies_before_final_rollout() (
  local log previous postgres_line zitadel_line migration_line deploy_line
  log="$(mktemp /tmp/rp-upgrade-dependency-order.XXXXXX)"
  previous="$(mktemp /tmp/rp-upgrade-previous-stack.XXXXXX.yml)"
  RP_UPGRADE_STATE_DIR="$(mktemp -d /tmp/rp-upgrade-journal.XXXXXX)"
  RP_INSTALLER_STATE_DIR="$RP_UPGRADE_STATE_DIR/installed"
  RP_UPGRADE_INSTALLER_CONFIG_FILE="$RP_UPGRADE_STATE_DIR/mock-installed/installer.conf"
  RP_UPGRADE_STACK_FILE="$RP_UPGRADE_STATE_DIR/mock-installed/stack.yml"
  local fixture_manifest="$RP_UPGRADE_STATE_DIR/target-manifest.json"
  printf '{"version":"0.2.14"}\n' >"$fixture_manifest"
  trap 'rm -f "$log" "$previous"; rm -rf "$RP_UPGRADE_STATE_DIR"' EXIT
  printf 'services: {}\n' >"$previous"
  RP_CFG_RELEASE_VERSION=0.2.13
  RP_CFG_ACME_ENVIRONMENT=production
  RP_CFG_DOMAIN=rp.example.test
  export RP_CFG_RELEASE_VERSION RP_CFG_ACME_ENVIRONMENT RP_CFG_DOMAIN
  rp_config_apply_defaults(){ printf 'defaults\n' >>"$log"; }
  rp_pull_release_images(){ printf 'pull\n' >>"$log"; }
  rp_apply_release_manifest_images(){ printf 'manifest-images\n' >>"$log"; }
  rp_upgrade_ensure_v020_node_labels(){ printf 'labels\n' >>"$log"; }
  rp_upgrade_refresh_firewall(){ printf 'firewall\n' >>"$log"; }
  rp_upgrade_quiesce_database_clients(){ printf 'clients-quiesced\n' >>"$log"; }
  rp_upgrade_prepare_postgres_services(){ printf 'postgres-ready\n' >>"$log"; }
  rp_upgrade_prepare_zitadel_for_mcp_oauth(){ printf 'zitadel-ready\n' >>"$log"; }
  rp_run_zitadel_mcp_oauth_reconcile(){ printf 'mcp-oauth\n' >>"$log"; }
  rp_run_migrations(){ printf 'migrations\n' >>"$log"; }
  rp_deploy_control_plane(){ printf 'deploy:%s\n' "$1" >>"$log"; }
  rp_wait_for_https_origin(){ printf 'https-ready\n' >>"$log"; }
  rp_upgrade_refresh_enrollment_listener(){ printf 'enrollment\n' >>"$log"; }
  rp_persist_release_manifest(){ printf '%s\n' "$1"; }
  rp_config_write(){ printf 'persist-config\n' >>"$log"; }
  rp_write_stack(){ printf 'persist-stack\n' >>"$log"; }
  rp_upgrade_apply "$fixture_manifest" "$previous"
  firewall_line="$(grep -n '^firewall$' "$log" | cut -d: -f1)"
  quiesce_line="$(grep -n '^clients-quiesced$' "$log" | cut -d: -f1)"
  postgres_line="$(grep -n '^postgres-ready$' "$log" | cut -d: -f1)"
  zitadel_line="$(grep -n '^zitadel-ready$' "$log" | cut -d: -f1)"
  migration_line="$(grep -n '^migrations$' "$log" | cut -d: -f1)"
  deploy_line="$(grep -n '^deploy:final$' "$log" | cut -d: -f1)"
  [[ "$firewall_line" -lt "$quiesce_line" && "$quiesce_line" -lt "$postgres_line" && "$postgres_line" -lt "$zitadel_line" && "$zitadel_line" -lt "$migration_line" && "$migration_line" -lt "$deploy_line" ]]
)
status 0 'upgrade gates PostgreSQL before ZITADEL, migrations and final rollout' upgrade_orders_dependencies_before_final_rollout

# Resume must restore release-derived image refs even when the release phase checkpoint is already complete.
resume_manifest="$(mktemp /tmp/rp-release-resume.XXXXXX.json)"
cat >"$resume_manifest" <<'EOF_RESUME_MANIFEST'
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "installer": {"minimumVersion": "0.1.0"},
  "docker": {"minimumVersion": "27.0.0"},
  "configSchemaVersion": 1,
  "images": {
    "api": "ghcr.io/re-invertion/resourceportal-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "web": "ghcr.io/re-invertion/resourceportal-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "postgres": "ghcr.io/re-invertion/resourceportal-postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "zitadel": "ghcr.io/zitadel/zitadel@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "traefik": "traefik@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "migrations": {"supportedFromVersions": ["0.1.0"], "rollbackPolicy": "none"}
}
EOF_RESUME_MANIFEST
unset RP_CFG_API_IMAGE RP_CFG_WEB_IMAGE RP_CFG_POSTGRES_IMAGE RP_CFG_ZITADEL_IMAGE RP_CFG_TRAEFIK_IMAGE RP_CFG_RELEASE_MANIFEST
RP_CFG_RELEASE_MANIFEST="$resume_manifest"
status 0 'resume restores release-derived image refs' rp_primary_restore_release_state
[[ "${RP_CFG_API_IMAGE:-}" == *'@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ]] && pass 'resume restores API image ref' || fail 'resume restores API image ref'

# An unfinished installation may refresh only the upstream Traefik image from a
# republished manifest of the exact same ResourcePortal version. Application
# images and release identity must remain pinned to the local release state.
refresh_manifest="$(mktemp /tmp/rp-release-refresh.XXXXXX.json)"
cat >"$refresh_manifest" <<'EOF_REFRESH_MANIFEST'
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "installer": {"minimumVersion": "0.1.0"},
  "docker": {"minimumVersion": "27.0.0"},
  "configSchemaVersion": 1,
  "images": {
    "api": "ghcr.io/re-invertion/resourceportal-api@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "web": "ghcr.io/re-invertion/resourceportal-web@sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "postgres": "ghcr.io/re-invertion/resourceportal-postgres@sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "zitadel": "ghcr.io/zitadel/zitadel@sha256:4444444444444444444444444444444444444444444444444444444444444444",
    "traefik": "traefik@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  },
  "migrations": {"supportedFromVersions": ["0.1.0"], "rollbackPolicy": "none"}
}
EOF_REFRESH_MANIFEST
old_api="$RP_CFG_API_IMAGE"
old_web="$RP_CFG_WEB_IMAGE"
old_postgres="$RP_CFG_POSTGRES_IMAGE"
old_zitadel="$RP_CFG_ZITADEL_IMAGE"
old_release="$RP_CFG_RELEASE_VERSION"
rp_download_release_manifest(){ cp "$refresh_manifest" "$2"; }
status 0 'unfinished resume refreshes compatible Traefik image' rp_primary_refresh_traefik_release_image
eq 'traefik@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' "${RP_CFG_TRAEFIK_IMAGE:-}" 'resume refresh updates only Traefik image'
eq "$old_api" "$RP_CFG_API_IMAGE" 'resume refresh preserves API image'
eq "$old_web" "$RP_CFG_WEB_IMAGE" 'resume refresh preserves Web image'
eq "$old_postgres" "$RP_CFG_POSTGRES_IMAGE" 'resume refresh preserves PostgreSQL image'
eq "$old_zitadel" "$RP_CFG_ZITADEL_IMAGE" 'resume refresh preserves ZITADEL image'
eq "$old_release" "$RP_CFG_RELEASE_VERSION" 'resume refresh preserves release version'
unset -f rp_download_release_manifest
rm -f "$refresh_manifest"

release_workflow="$(cat "$repo_root/.github/workflows/release.yml")"
contains "$release_workflow" 'traefik:v3.6.16' 'release pins Docker-29-compatible Traefik'
not_contains "$release_workflow" 'traefik:v3.5' 'release no longer pins incompatible Traefik 3.5'

rm -f "$resume_manifest"


if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer release tests passed.\n'