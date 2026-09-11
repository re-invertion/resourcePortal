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
    "postgres": "postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "zitadel": "ghcr.io/zitadel/zitadel@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "traefik": "traefik@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "migrations": {
    "supportedFromVersions": ["0.1.0"],
    "rollbackPolicy": "none"
  }
}
JSON

status 0 'valid release manifest accepted' rp_validate_release_manifest "$manifest"
eq '0.2.0' "$(rp_manifest_value "$manifest" '.version')" 'reads release version'
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
status 1 'irreversible migration refuses automatic rollback' rp_upgrade_rollback_allowed "$manifest"

safe_manifest="$(mktemp /tmp/rp-release-safe.XXXXXX.json)"
sed 's/"rollbackPolicy": "none"/"rollbackPolicy": "image-only"/' "$manifest" >"$safe_manifest"
status 0 'explicit image-only compatibility allows rollback' rp_upgrade_rollback_allowed "$safe_manifest"

mutable="$(mktemp /tmp/rp-release-mutable.XXXXXX.json)"
sed 's#ghcr.io/re-invertion/resourceportal-api@sha256:[a-f]*#ghcr.io/re-invertion/resourceportal-api:latest#' "$manifest" >"$mutable"
status 1 'mutable latest image rejected' rp_validate_release_manifest "$mutable"

workflow="$(cat "$repo_root/.github/workflows/release.yml")"
contains "$workflow" 'packages: write' 'release workflow can publish GHCR'
contains "$workflow" 'workflow_dispatch:' 'release workflow supports controlled manual republish'
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
not_contains "$workflow" ':latest' 'release workflow never publishes latest tag'

schema="$(cat "$repo_root/config/production/release-manifest.schema.json")"
contains "$schema" 'rollbackPolicy' 'manifest schema declares rollback policy'
contains "$schema" 'minimumVersion' 'manifest schema declares installer compatibility'

rm -f "$manifest" "$safe_manifest" "$mutable"

upgrade_source="$(cat "$repo_root/scripts/installer/upgrade.sh")"
contains "$upgrade_source" 'rp_wait_for_https_origin' 'upgrade verifies ResourcePortal health after deploy'
contains "$upgrade_source" 'rp_config_write' 'upgrade persists release state only after successful health check'
contains "$upgrade_source" 'RP_CFG_RELEASE_VERSION=' 'upgrade records selected release version'

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
