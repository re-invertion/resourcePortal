#!/usr/bin/env bash
# One-time, administrator-operated recovery when an installed 0.2.68 worker
# launches its own older (BusyBox-incompatible) installer for an upgrade.
set -euo pipefail

target_version=0.2.71
stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
[[ "${1:-}" == --confirm ]] || {
  printf 'Usage: sudo bash %s --confirm\nThis runs the pinned v%s installer against the live platform.\n' "$0" "$target_version" >&2
  exit 2
}
[[ "$EUID" == 0 ]] || { printf 'Run as root on the ResourcePortal Swarm manager.\n' >&2; exit 1; }
for tool in curl docker jq mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$tool" >&2; exit 1; }
done
[[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" == true ]] || {
  printf 'This command must run on an active Docker Swarm manager.\n' >&2
  exit 1
}
worker="${stack_name}_worker"
docker service inspect "$worker" >/dev/null || {
  printf 'ResourcePortal worker service is not available: %s\n' "$worker" >&2
  exit 1
}
[[ -z "$(docker ps -q --filter label=resourceportal.updater=true)" ]] || {
  printf 'Another ResourcePortal updater is running; refusing concurrent upgrade.\n' >&2
  exit 1
}
worker_env="$(docker service inspect "$worker" --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}')"
storage_base="$(jq -er 'map(select(startswith("RESOURCE_STORAGE_BASE_PATH=")) | split("=")[1:] | join("="))[0] // empty' <<<"$worker_env")" || exit 1
storage_device="$(jq -er 'map(select(startswith("RESOURCE_STORAGE_QUOTA_DEVICE=")) | split("=")[1:] | join("="))[0] // empty' <<<"$worker_env")" || exit 1
[[ "$storage_base" == /* && "$storage_base" != *:* && -d "$storage_base" ]] || {
  printf 'Invalid or inaccessible ResourcePortal storage base.\n' >&2; exit 1
}
[[ "$storage_device" == /dev/* && -b "$storage_device" ]] || {
  printf 'Invalid or inaccessible ResourcePortal storage quota device.\n' >&2; exit 1
}
workspace="$(mktemp -d /tmp/resourceportal-upgrade-recovery.XXXXXX)"
trap 'rm -rf "$workspace"' EXIT
manifest="$workspace/resourceportal-release-manifest.json"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  "https://github.com/re-invertion/resourcePortal/releases/download/v${target_version}/resourceportal-release-manifest.json" \
  -o "$manifest"
jq -e --arg version "$target_version" '
  .schemaVersion == 1 and .version == $version and
  (.images.api | type == "string" and
    test("^ghcr[.]io/re-invertion/resourceportal-api@sha256:[a-f0-9]{64}$"))
' "$manifest" >/dev/null || { printf 'Untrusted or invalid release manifest.\n' >&2; exit 1; }
image="$(jq -er '.images.api' "$manifest")"
docker pull "$image" >/dev/null
container="resourceportal-upgrade-recovery-$(date +%s)-$RANDOM"
printf 'Starting pinned v%s upgrade in container %s\n' "$target_version" "$container"
docker run -d \
  --name "$container" --user 0 --network host \
  --label resourceportal.updater=true \
  --label "resourceportal.target-version=$target_version" \
  -e RP_NON_INTERACTIVE=true -e RP_UI_MODE=text -e RP_UPGRADE_SKIP_HOST_FIREWALL=true \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /etc/resourceportal:/etc/resourceportal \
  -v /var/lib/resourceportal:/var/lib/resourceportal \
  -v "$storage_base:$storage_base" \
  -v /mnt/resourceportal/platform:/mnt/resourceportal/platform \
  -v "$manifest:/tmp/resourceportal-release-manifest.json:ro" \
  --device "$storage_device:$storage_device" \
  "$image" /bin/bash /app/resourceportal-installer/resourceportal-install.sh \
  --mode upgrade --manifest /tmp/resourceportal-release-manifest.json --non-interactive >/dev/null
docker logs --follow "$container" || true
exit_code="$(docker wait "$container")"
if [[ "$exit_code" != 0 ]]; then
  printf 'Upgrade failed (exit %s). Inspect: docker logs %s. Container kept for diagnosis.\n' "$exit_code" "$container" >&2
  exit 1
fi
docker rm "$container" >/dev/null
printf 'Upgrade installer completed successfully to v%s. Verify API health and deployed version.\n' "$target_version"
