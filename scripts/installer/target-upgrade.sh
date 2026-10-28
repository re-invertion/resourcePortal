#!/usr/bin/env bash
# The source-version supervisor verifies provenance, then delegates ALL installer
# work to the immutable target image. Never mix source shell with target bootstrap.
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/common.sh"
source "$root/scripts/installer/releases.sh"

rp_launch_target_upgrade() (
  local version="${RP_TARGET_VERSION:-}" url="${RP_TARGET_MANIFEST_URL:-}"
  local name="${RP_TARGET_CONTAINER:-}" base="${RP_UPDATER_STORAGE_BASE:-}"
  local device="${RP_UPDATER_STORAGE_DEVICE:-}" dir manifest image exit_code
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "$url" == "https://github.com/re-invertion/resourcePortal/releases/download/v${version}/resourceportal-release-manifest.json" ]] || return 1
  [[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$ ]] || return 1
  [[ "$base" == /* && "$base" != *:* && "$base" != *$'\n'* && "$base" != / ]] || return 1
  [[ "$device" == /dev/* && "$device" != *:* && "$device" != *$'\n'* ]] || return 1
  dir="$(mktemp -d /tmp/resourceportal-target-upgrade.XXXXXX)" || return 1
  trap 'rm -rf -- "$dir"' EXIT
  manifest="$dir/resourceportal-release-manifest.json"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$url" -o "$manifest" || return 1
  rp_validate_release_manifest "$manifest" || return 1
  [[ "$(jq -er '.version' "$manifest")" == "$version" ]] || {
    printf 'Target manifest version does not match the requested release.\n' >&2; return 1;
  }
  rp_verify_release_manifest_attestation "$manifest" || return 1
  image="$(jq -er '.images.api' "$manifest")" || return 1
  if docker inspect "$name" >/dev/null 2>&1; then
    printf 'Target installer container already exists; inspect it before retry: %s\n' "$name" >&2
    return 1
  fi
  rp_pull_image_with_retry "$image" || return 1
  docker create --name "$name" --user 0 --network host \
    --label resourceportal.upgrade-installer=true \
    --label "resourceportal.target-version=$version" \
    -e RP_NON_INTERACTIVE=true -e RP_UI_MODE=text -e RP_UPGRADE_SKIP_HOST_FIREWALL=true \
    -e "RP_INSTALLER_VERSION=$version" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /etc/resourceportal:/etc/resourceportal \
    -v /run/lock:/run/lock \
    -v /var/lib/resourceportal:/var/lib/resourceportal \
    -v "$base:$base" -v /mnt/resourceportal/platform:/mnt/resourceportal/platform \
    --device "$device:$device" \
    "$image" /bin/bash /app/resourceportal-installer/resourceportal-install.sh \
    --mode upgrade --manifest /tmp/resourceportal-release-manifest.json --non-interactive >/dev/null || return 1
  docker cp "$manifest" "$name:/tmp/resourceportal-release-manifest.json" || return 1
  # Retain a failed target so its full logs remain available independently of the
  # supervisor's lifetime. Propagate its actual exit status, not Docker attach's.
  if ! docker start --attach "$name"; then
    case "$(docker inspect "$name" --format '{{.State.Status}}')" in
      running|exited) ;;
      *) printf 'Target installer could not start: %s\n' "$name" >&2; return 1 ;;
    esac
  fi
  exit_code="$(docker wait "$name")" || return 1
  [[ "$exit_code" == 0 ]] || {
    printf 'Target installer failed (exit %s). Inspect docker logs %s; checkpoint retained.\n' "$exit_code" "$name" >&2
    return 1
  }
  docker rm "$name" >/dev/null || return 1
)
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  rp_launch_target_upgrade
fi
