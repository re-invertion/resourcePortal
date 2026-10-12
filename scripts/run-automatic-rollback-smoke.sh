#!/usr/bin/env bash
# Mandatory release gate: exercise the real installer rollback function against
# a disposable Docker Swarm with a deliberately failed workload update.
# This proves image-only stack re-deployment and checkpoint restoration; it does
# NOT prove SQL/data rollback or recovery from host/storage failure.
set -euo pipefail

source_version="${1:-}"
[[ "$source_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Usage: $0 PREVIOUS_PUBLISHED_VERSION (no v prefix)" >&2
  exit 1
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
command -v jq >/dev/null && command -v docker >/dev/null && command -v flock >/dev/null || {
  echo "Mandatory rollback smoke requires jq, Docker and flock." >&2; exit 1;
}
docker info >/dev/null
current_sha="$(git rev-parse HEAD)"
[[ "$current_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
root="$(mktemp -d /tmp/resourceportal-rollback-gate.XXXXXX)"
stack="rp-rollback-gate-${GITHUB_RUN_ID:-$$}"
stack="${stack//[^a-zA-Z0-9_-]/-}"
swarm_started=false
cleanup() {
  docker stack rm "$stack" >/dev/null 2>&1 || true
  if [[ "$swarm_started" == true ]]; then docker swarm leave --force >/dev/null 2>&1 || true; fi
  rm -rf -- "$root"
}
trap cleanup EXIT
advertise="$(hostname -I | awk '{print $1}')"
[[ -n "$advertise" ]] || { echo "No Docker Swarm advertise address" >&2; exit 1; }
docker swarm init --advertise-addr "$advertise" >/dev/null
swarm_started=true
image="public.ecr.aws/docker/library/nginx:alpine"
docker pull "$image" >/dev/null
image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
[[ "$image" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1

cat >"$root/previous-stack.yml" <<YAML
version: "3.8"
services:
  web:
    image: $image
    deploy:
      replicas: 1
YAML
cat >"$root/target-stack.yml" <<YAML
version: "3.8"
services:
  web:
    image: $image
    deploy:
      replicas: 2
YAML

wait_replicas() {
  local expected="$1" count
  for ((count=0;count<90;count++)); do
    if [[ "$(docker service ls --filter "name=${stack}_web" --format '{{.Replicas}}')" == "$expected" ]]; then
      return 0
    fi
    sleep 2
  done
  docker service ps --no-trunc "${stack}_web" >&2 || true
  echo "Swarm service did not converge to $expected" >&2
  return 1
}
docker stack deploy --compose-file "$root/previous-stack.yml" --with-registry-auth --prune "$stack" >/dev/null
wait_replicas "1/1" || exit 1

# A manifest satisfying the production validator, with test-only fake image
# references. It is never published or installed on a real ResourcePortal.
sha64="$(printf '%064d' 0)"
jq -n --arg source "$source_version" --arg sha "$sha64" '
  {schemaVersion:1, version:$source,
   installer:{minimumVersion:"0.1.0"},docker:{minimumVersion:"27.0.0"},
   configSchemaVersion:1,
   images:{
     api:("ghcr.io/re-invertion/resourceportal-api@sha256:"+$sha),
     web:("ghcr.io/re-invertion/resourceportal-web@sha256:"+$sha),
     postgres:("ghcr.io/re-invertion/resourceportal-postgres@sha256:"+$sha),
     zitadel:("ghcr.io/zitadel/zitadel@sha256:"+$sha),
     traefik:("traefik@sha256:"+$sha)
   },
   migrations:{supportedFromVersions:[$source],rollbackPolicy:"none"}}' >"$root/previous-release.json"
jq --arg source "$source_version" --arg commit "$current_sha" '
  .version="99.99.99"
  | .migrations.rollbackPolicy="image-only"
  | .migrations.rollbackAssessment={
      reason:"no-resourceportal-database-schema-changes",
      sourceVersion:$source,targetCommit:$commit
    }' "$root/previous-release.json" >"$root/target-release.json"

export RP_UPGRADE_STATE_DIR="$root/checkpoint"
export RP_INSTALLER_STATE_DIR="$root/installed"
export RP_UPGRADE_INSTALLER_CONFIG_FILE="$root/installer.conf"
export RP_UPGRADE_STACK_FILE="$root/installed-stack.yml"
export RP_CFG_RELEASE_VERSION="$source_version"
export RP_UPGRADE_SOURCE_VERSION="$source_version"
export RP_CFG_DOMAIN="rollback-smoke.invalid"
export RP_CFG_STACK_NAME="$stack"
mkdir -p "$RP_INSTALLER_STATE_DIR"
cp "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cp "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
printf 'previous config\n' >"$RP_UPGRADE_INSTALLER_CONFIG_FILE"

# Load the production policy, checkpoint and restore implementation unchanged.
# Only HTTP origin validation is swapped for a real Swarm convergence check:
# the disposable nginx service is not an HTTPS ResourcePortal API.
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
rp_wait_for_https_origin() { wait_replicas "1/1"; }

rp_validate_release_manifest "$root/target-release.json"
rp_upgrade_rollback_allowed "$root/target-release.json"
rp_upgrade_checkpoint_prepare "$root/target-release.json" "$root/previous-stack.yml" "$source_version"
rp_upgrade_checkpoint_phase applying "fault-injection" 
docker stack deploy --compose-file "$root/target-stack.yml" --with-registry-auth --prune "$stack" >/dev/null
wait_replicas "2/2"

# This function deliberately returns failure even after successful rollback:
# the original update still failed. Check the resulting state independently.
if rp_upgrade_restore_after_failure "$root/target-release.json" "$root/previous-stack.yml" "injected-target-failure"; then
  echo "Rollback path incorrectly marked the failed update successful" >&2
  exit 1
fi
[[ "$(jq -er .phase "$RP_UPGRADE_STATE_DIR/state.json")" == "rolled-back" ]] || {
  echo "Checkpoint not marked rolled-back" >&2; exit 1;
}
wait_replicas "1/1"
cmp -s "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cmp -s "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
[[ "$(cat "$RP_UPGRADE_INSTALLER_CONFIG_FILE")" == "previous config" ]]
echo "PASS: actual Swarm reverted 2/2 to 1/1, prior metadata/config restored, checkpoint rolled-back."
