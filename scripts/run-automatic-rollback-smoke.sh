#!/usr/bin/env bash
# Required publication safety test: run the *real* rp_upgrade_apply entry point
# against the actual previously published RP image digests and current locally
# built API/Web/Postgres release-candidate images, then inject a health failure.
# This proves image-only rollback orchestration; never claims SQL/data recovery.
set -euo pipefail

source_version="${1:-}"
[[ "$source_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Usage: $0 PREVIOUS_PUBLISHED_VERSION (without v)" >&2
  exit 1
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
for cmd in jq docker curl gh flock; do
  command -v "$cmd" >/dev/null || { echo "Required rollback tool missing: $cmd" >&2; exit 1; }
done
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

# Never synthesize the rollback source: require the immutable official manifest
# and its signed attestation from the immediately preceding published release.
base_url="https://github.com/re-invertion/resourcePortal/releases/download/v${source_version}"
curl --fail --silent --show-error --location --proto '=https' \
  "$base_url/resourceportal-release-manifest.json" -o "$root/previous-release.json"
curl --fail --silent --show-error --location --proto '=https' \
  "$base_url/resourceportal-release-manifest.bundle.json" -o "$root/source.bundle.json"
GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 gh attestation verify "$root/previous-release.json" \
  --bundle "$root/source.bundle.json" --repo re-invertion/resourcePortal \
  --signer-workflow re-invertion/resourcePortal/.github/workflows/release.yml \
  --source-ref refs/heads/main >/dev/null
source "$repo_root/scripts/installer/releases.sh"
source "$repo_root/scripts/installer/upgrade.sh"
rp_validate_release_manifest "$root/previous-release.json"
[[ "$(jq -er .version "$root/previous-release.json")" == "$source_version" ]] || exit 1

for role in api web postgres; do
  source_image="$(jq -er --arg role "$role" '.images[$role]' "$root/previous-release.json")"
  [[ "$source_image" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1
  docker pull "$source_image" >/dev/null
  docker image inspect "resourceportal-${role}-candidate" >/dev/null
done
source_api="$(jq -er .images.api "$root/previous-release.json")"
source_web="$(jq -er .images.web "$root/previous-release.json")"
source_postgres="$(jq -er .images.postgres "$root/previous-release.json")"

cat >"$root/previous-stack.yml" <<YAML
services:
  api:
    image: $source_api
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  web:
    image: $source_web
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  postgres:
    image: $source_postgres
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
YAML
cat >"$root/target-stack.yml" <<'YAML'
services:
  api:
    image: resourceportal-api-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  web:
    image: resourceportal-web-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
  postgres:
    image: resourceportal-postgres-candidate
    entrypoint: ["/bin/sh", "-c", "sleep 3600"]
    command: []
    deploy: {replicas: 1}
YAML

# Target manifest contains image IDs of the exact candidate binaries tested
# in this job. Public registry digests are not known until publication.
candidate_api="$(docker image inspect --format '{{.Id}}' resourceportal-api-candidate)"
candidate_web="$(docker image inspect --format '{{.Id}}' resourceportal-web-candidate)"
candidate_postgres="$(docker image inspect --format '{{.Id}}' resourceportal-postgres-candidate)"
jq --arg commit "$current_sha" --arg source "$source_version" \
   --arg api "$candidate_api" --arg web "$candidate_web" --arg postgres "$candidate_postgres" '
  .version="99.99.99"
  | .images.api=("ghcr.io/re-invertion/resourceportal-api@" + $api)
  | .images.web=("ghcr.io/re-invertion/resourceportal-web@" + $web)
  | .images.postgres=("ghcr.io/re-invertion/resourceportal-postgres@" + $postgres)
  | .migrations.rollbackPolicy="image-only"
  | .migrations.rollbackAssessment={
      reason:"no-resourceportal-database-schema-changes",
      sourceVersion:$source,targetCommit:$commit
    }' "$root/previous-release.json" >"$root/target-release.json"
rp_validate_release_manifest "$root/target-release.json"
docker swarm init --advertise-addr "$(hostname -I | awk '{print $1}')" >/dev/null
swarm_started=true

service_images_match() {
  local phase="$1" role expected observed
  for role in api web postgres; do
    if [[ "$phase" == previous ]]; then
      expected="$(jq -er --arg role "$role" '.images[$role]' "$root/previous-release.json")"
    else
      expected="resourceportal-${role}-candidate:latest"
    fi
    observed="$(docker service inspect "${stack}_${role}" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null)" || return 1
    [[ "$observed" == "$expected" ]] || {
      echo "Wrong $phase image for $role: expected $expected, got $observed" >&2
      return 1
    }
  done
}

wait_services() {
  local phase="$1" attempt role ready
  for ((attempt=0;attempt<90;attempt++)); do
    ready=true
    for role in api web postgres; do
      [[ "$(docker service ls --filter "name=${stack}_${role}" --format '{{.Replicas}}')" == "1/1" ]] || ready=false
    done
    if [[ "$ready" == true ]] && service_images_match "$phase"; then return 0; fi
    sleep 2
  done
  for role in api web postgres; do docker service ps --no-trunc "${stack}_${role}" >&2 || true; done
  echo "Rollback smoke services did not converge ($phase)" >&2
  return 1
}
docker stack deploy --compose-file "$root/previous-stack.yml" --with-registry-auth --prune "$stack" >/dev/null
wait_services previous

export RP_UPGRADE_STATE_DIR="$root/checkpoint"
export RP_INSTALLER_STATE_DIR="$root/installed"
export RP_UPGRADE_INSTALLER_CONFIG_FILE="$root/installer.conf"
export RP_UPGRADE_STACK_FILE="$root/installed-stack.yml"
export RP_CFG_RELEASE_VERSION="$source_version"
export RP_UPGRADE_SOURCE_VERSION="$source_version"
export RP_CFG_DOMAIN="rollback-smoke.invalid"
export RP_CFG_STACK_NAME="$stack"
export RP_CFG_ACME_ENVIRONMENT=production
mkdir -p "$RP_INSTALLER_STATE_DIR"
cp "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cp "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
printf 'previous config\n' >"$RP_UPGRADE_INSTALLER_CONFIG_FILE"

# Only external platform dependencies are stubbed, not the upgrade or
# rollback state machine, checkpoints, Docker deployment or compatibility gate.
# The unsigned *candidate* manifest cannot yet have official release provenance.
rp_config_apply_defaults() { return 0; }
rp_verify_release_manifest_attestation() { return 0; }
rp_upgrade_identity_preflight() { return 0; }
rp_pull_release_images() { return 0; }
rp_apply_release_manifest_images() { return 0; }
rp_upgrade_ensure_v020_node_labels() { return 0; }
rp_upgrade_refresh_firewall() { return 0; }
rp_upgrade_quiesce_database_clients() { return 0; }
rp_upgrade_prepare_postgres_services() { return 0; }
rp_upgrade_prepare_zitadel_for_mcp_oauth() { return 0; }
rp_run_zitadel_mcp_oauth_reconcile() { return 0; }
rp_run_migrations() { return 0; }
rp_deploy_control_plane() {
  docker stack deploy --resolve-image never --compose-file "$root/target-stack.yml" \
    --with-registry-auth --prune "$stack" >/dev/null || return 1
  wait_services target || return 1
  # Simulate an update that overwrote persisted configuration prior to a
  # fatal post-deployment check. The actual rollback must restore it.
  printf 'target config\n' >"$RP_UPGRADE_INSTALLER_CONFIG_FILE"
  printf 'target stack\n' >"$RP_UPGRADE_STACK_FILE"
}
health_checks=0
rp_wait_for_https_origin() {
  health_checks=$((health_checks + 1))
  if [[ "$health_checks" -eq 1 ]]; then
    # Fail *inside rp_upgrade_apply*, after the candidate services converge.
    # The production entry point must call rollback itself.
    wait_services target || return 1
    echo "Injected target health-check failure" >&2
    return 1
  fi
  # The recovered service image digests and running replicas are real;
  # no pretend-healthy return value can mask incorrect restoration.
  wait_services previous
}

if rp_upgrade_apply "$root/target-release.json" "$root/previous-stack.yml"; then
  echo "Injected failed upgrade unexpectedly succeeded" >&2
  exit 1
fi
[[ "$health_checks" -eq 2 ]] || {
  echo "Upgrade entry point did not automatically invoke rollback health verification" >&2
  exit 1
}
[[ "$(jq -er .phase "$RP_UPGRADE_STATE_DIR/state.json")" == "rolled-back" ]]
wait_services previous
cmp -s "$root/previous-release.json" "$RP_INSTALLER_STATE_DIR/release.json"
cmp -s "$root/previous-stack.yml" "$RP_UPGRADE_STACK_FILE"
[[ "$(cat "$RP_UPGRADE_INSTALLER_CONFIG_FILE")" == "previous config" ]]
echo "PASS: automatic upgrade failure handler restored previous published RP images and checkpoint."
