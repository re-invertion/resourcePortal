#!/usr/bin/env bash
# Reviewed, version-pinned operator recovery for the specific OAuth failure.
# Default: read-only plan. No checkpoint is changed until verified backups exist.
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for library in common config releases upgrade identity recovery; do
  source "$root/scripts/installer/$library.sh"
done
mode=plan
case "${1:---plan}" in
  --plan) [[ $# -le 1 ]] || exit 2 ;;
  --apply) [[ "${2:-}" == --confirm && "${3:-}" == 0.2.78:0.2.81 && $# == 3 ]] || {
    printf 'Usage: sudo bash %s --apply --confirm 0.2.78:0.2.81\n' "$0" >&2; exit 2;
  }; mode=apply ;;
  *) printf 'Usage: sudo bash %s [--plan | --apply --confirm 0.2.78:0.2.81]\n' "$0" >&2; exit 2 ;;
esac
[[ "$EUID" == 0 ]] || { printf 'Run on the Primary manager as root.\n' >&2; exit 1; }
for tool in docker curl jq sha256sum flock tar cmp; do
  command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
[[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" == true ]] || exit 1
dir=/var/lib/resourceportal/installer-state/upgrade
config=/etc/resourceportal/installer.conf
installed=/var/lib/resourceportal/installer-state/release.json
stack_file=/etc/resourceportal/stack.yml
rp_config_load "$config" || exit 1
[[ "${RP_CFG_RELEASE_VERSION:-}" == 0.2.78 ]] || { printf 'Recovery refused: installed version is not 0.2.78.\n' >&2; exit 1; }
stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
updater=resourceportal-updater-240299fa-e7eb-4a06-a3b0-5516bfa1f928
[[ "$(docker inspect "$updater" --format '{{.State.Status}} {{.State.ExitCode}}')" == 'exited 1' ]] || exit 1
[[ "$(docker inspect "$updater" --format '{{.Config.Image}}')" == "$(jq -er '.images.api' "$installed")" ]] || {
  printf 'Recovery refused: failed updater is not the recorded source image.\n' >&2; exit 1;
}
logs="$(docker logs "$updater" 2>&1)"
[[ "$logs" == *'Production federation attestation requires secret and internal callback'* &&
   "$logs" == *'ResourcePortal update failed at MCP OAuth reconciliation.'* ]] || exit 1
for label in resourceportal.updater=true resourceportal.upgrade-installer=true; do
  [[ -z "$(docker ps -q --filter "label=$label")" ]] || { printf 'Another updater is running.\n' >&2; exit 1; }
done
for service in api worker dr-reconciliation; do
  [[ "$(docker service inspect "${stack}_$service" --format '{{.Spec.Mode.Replicated.Replicas}}')" == 0 ]] || {
    printf 'Recovery refused: %s must still be quiesced.\n' "$service" >&2; exit 1;
  }
done
work="$(mktemp -d /tmp/resourceportal-oauth-recovery.XXXXXX)"
trap 'rm -rf -- "$work"; rp_installer_lock_release' EXIT
target="$work/manifest.json"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  https://github.com/re-invertion/resourcePortal/releases/download/v0.2.81/resourceportal-release-manifest.json -o "$target"
rp_validate_release_manifest "$target" || exit 1
rp_recovery_verify_checkpoint "$dir" "$target" "$installed" "$config" "$stack_file" || exit 1
rp_upgrade_identity_preflight || exit 1
image="$(jq -er '.images.api' "$target")"
base="${RP_CFG_STORAGE_BASE_PATH:-}"
device="${RP_CFG_STORAGE_DEVICE:-}"
[[ "$base" == /* && "$base" != / && "$base" != *:* && -d "$base" && "$device" == /dev/* && -b "$device" ]] || exit 1
# Backups and schema checks must address exactly one healthy local database task.
declare -A db
for role in postgres-rp postgres-zitadel; do
  mapfile -t ids < <(docker ps -q --filter "label=com.docker.swarm.service.name=${stack}_$role")
  [[ "${#ids[@]}" == 1 && "$(docker inspect "${ids[0]}" --format '{{.State.Health.Status}}')" == healthy ]] || {
    printf 'Recovery refused: %s needs one healthy local task.\n' "$role" >&2; exit 1;
  }
  [[ "$(docker service inspect "${stack}_$role" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')" == "$(jq -er '.images.postgres' "$target")" ]] || exit 1
  db[$role]="${ids[0]}"
done
# Prove RP schema is exactly the source migration set, including SQL checksums,
# rather than inferring compatibility merely from the installer's error message.
mkdir "$work/source-prisma"
docker cp "$updater:/app/packages/resourceportal-api/prisma/migrations" - | tar -xf - -C "$work/source-prisma"
: > "$work/expected-migrations"
while IFS= read -r sql; do
  printf '%s|%s\n' "$(basename "$(dirname "$sql")")" "$(sha256sum "$sql" | cut -d' ' -f1)" >> "$work/expected-migrations"
done < <(find "$work/source-prisma" -type f -name migration.sql | sort)
[[ -s "$work/expected-migrations" ]] || exit 1
docker exec --user postgres "${db[postgres-rp]}" sh -ec \
  'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name || chr(124) || checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"' > "$work/actual-migrations"
cmp -s "$work/expected-migrations" "$work/actual-migrations" || {
  printf 'Recovery refused: RP database migration names/checksums differ from source 0.2.78.\n' >&2; exit 1;
}
pending="$(docker exec --user postgres "${db[postgres-rp]}" sh -ec \
  'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"')"
[[ "$pending" == 0 ]] || exit 1
[[ "$(docker service inspect "${stack}_zitadel" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')" == "$(jq -er '.images.zitadel' "$target")" ]] || exit 1
if [[ "$mode" == plan ]]; then
  printf 'Verified recovery plan: 0.2.78 -> 0.2.81; source schema unchanged; OAuth failure identified.\n'
  printf 'Target installer: %s\n' "$image"
  printf 'Apply will verify release signature, back up both databases/config/state/encrypted secrets, archive original checkpoint and run target installer.\n'
  if ! command -v gh >/dev/null; then
    printf 'Apply prerequisite missing: GitHub CLI (gh) for official signed provenance. No production changes made.\n' >&2
  else
    rp_verify_release_manifest_attestation "$target" || exit 1
  fi
  exit 0
fi
rp_verify_release_manifest_attestation "$target" || exit 1
rp_installer_lock_acquire || exit 1
exec {checkpoint_lock}>"$dir/lock"
flock -n "$checkpoint_lock" || exit 1
# Revalidate inside the lock; do not trust the preceding plan's observations.
rp_recovery_verify_checkpoint "$dir" "$target" "$installed" "$config" "$stack_file" || exit 1
backup="/var/backups/resourceportal/oauth-recovery-$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$backup"
for role in postgres-rp postgres-zitadel; do
  file=resourceportal; [[ "$role" == postgres-zitadel ]] && file=zitadel
  docker exec --user postgres "${db[$role]}" sh -ec \
    'pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$backup/$file.dump"
  docker exec -i --user postgres "${db[$role]}" pg_restore --list < "$backup/$file.dump" > "$backup/$file.dump-list"
  docker exec --user postgres "${db[$role]}" sh -ec \
    'pg_dumpall --globals-only -U "$POSTGRES_USER"' > "$backup/$file.roles.sql"
done
tar -czf "$backup/host-state.tar.gz" -C / etc/resourceportal var/lib/resourceportal
tar -czf "$backup/encrypted-secrets.tar.gz" -C "$base" secrets
cp "$work/actual-migrations" "$backup/source-migrations.txt"
cp "$target" "$backup/target-manifest.json"
printf '%s\n' "$logs" > "$backup/failed-updater.log"
(cd "$backup" && sha256sum ./*.dump ./*.dump-list ./*.roles.sql ./*.tar.gz ./*.json ./*.txt ./*.log > SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null)
docker pull "$image" >/dev/null
name="resourceportal-oauth-recovery-$(date +%s)-$$"
docker create --name "$name" --user 0 --network host --label resourceportal.updater=true \
  --label resourceportal.target-version=0.2.81 \
  -e "RP_RECOVERY_BACKUP=$backup" -e "RP_RECOVERY_CHECKPOINT_SHA256=$(sha256sum "$dir/state.json" | cut -d' ' -f1)" \
  -e RP_NON_INTERACTIVE=true -e RP_UI_MODE=text -e RP_UPGRADE_SKIP_HOST_FIREWALL=true -e RP_INSTALLER_VERSION=0.2.81 \
  -v /var/run/docker.sock:/var/run/docker.sock -v /etc/resourceportal:/etc/resourceportal \
  -v /run/lock:/run/lock -v "$backup:$backup:ro" \
  -v /var/lib/resourceportal:/var/lib/resourceportal -v "$base:$base" \
  -v /mnt/resourceportal/platform:/mnt/resourceportal/platform --device "$device:$device" \
  "$image" /bin/bash /app/resourceportal-installer/resourceportal-install.sh \
  --mode upgrade --manifest /tmp/resourceportal-release-manifest.json --non-interactive > /dev/null
docker cp "$target" "$name:/tmp/resourceportal-release-manifest.json"
# Only the checkpoint_prepare function is adapted. The target retains its
# published preflight, OAuth bootstrap, migrations and health verification.
docker cp "$name:/app/resourceportal-installer/scripts/installer/upgrade.sh" "$work/target-upgrade.sh"
cat "$root/scripts/installer/recovery.sh" >> "$work/target-upgrade.sh"
cat >> "$work/target-upgrade.sh" <<'ADAPTER'
rp_upgrade_checkpoint_prepare() {
  rp_recovery_prepare_checkpoint "$@"
}
ADAPTER
docker cp "$work/target-upgrade.sh" "$name:/app/resourceportal-installer/scripts/installer/upgrade.sh"
rp_recovery_archive_checkpoint "$dir" "$backup" || exit 1
flock -u "$checkpoint_lock"
exec {checkpoint_lock}>&-
rp_installer_lock_release
# The original unresolved state remains until the target obtains both locks.
# Preserve both containers and every backup if the target fails again.
if ! docker start --attach "$name"; then
  status="$(docker inspect "$name" --format '{{.State.Status}}')" || exit 1
  case "$status" in
    running|exited) ;;
    *) printf 'Recovery target failed to start; active checkpoint retained. Container: %s\n' "$name" >&2; exit 1 ;;
  esac
fi
result="$(docker wait "$name")"
[[ "$result" == 0 ]] || {
  printf 'Recovery failed. Backup: %s; logs: docker logs %s. Do not rerun blindly.\n' "$backup" "$name" >&2; exit 1;
}
rp_config_load "$config"
[[ "${RP_CFG_RELEASE_VERSION:-}" == 0.2.81 && "$(jq -er '.phase' "$dir/state.json")" == completed ]] || exit 1
for service in api worker dr-reconciliation postgres-rp postgres-zitadel traefik web zitadel; do
  observed="$(docker service ls --filter "name=${stack}_$service" --format '{{.Replicas}}')"
  [[ "$observed" == 1/1 ]] || { printf 'Post-recovery verification failed: %s %s\n' "$service" "$observed" >&2; exit 1; }
done
curl --fail --silent --show-error "https://${RP_CFG_DOMAIN}/api/health/ready" | jq -e '.status == "ok" and .version == "0.2.81"' >/dev/null
curl --fail --silent --show-error "https://${RP_CFG_DOMAIN}/api/health/worker" | jq -e ' .status == "ok" and .workers.active > 0' >/dev/null
curl --fail --silent --show-error "https://${RP_CFG_DOMAIN}/" >/dev/null
curl --fail --silent --show-error "https://${RP_CFG_ZITADEL_DOMAIN}/.well-known/openid-configuration" | jq -e '.issuer and .authorization_endpoint' >/dev/null
printf 'Recovery installer completed and services verified. Backup/evidence preserved at %s. Verify interactive OIDC and MCP login before closing the incident.\n' "$backup"
