#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
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
contains "$workflow" 'docker/build-push-action' 'release workflow builds immutable images'
contains "$workflow" 'resourceportal-release-manifest.json' 'release workflow publishes machine-readable manifest'
not_contains "$workflow" ':latest' 'release workflow never publishes latest tag'

schema="$(cat "$repo_root/config/production/release-manifest.schema.json")"
contains "$schema" 'rollbackPolicy' 'manifest schema declares rollback policy'
contains "$schema" 'minimumVersion' 'manifest schema declares installer compatibility'

rm -f "$manifest" "$safe_manifest" "$mutable"
if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer release tests passed.\n'
