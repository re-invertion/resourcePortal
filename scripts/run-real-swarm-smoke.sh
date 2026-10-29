#!/usr/bin/env bash
set -euo pipefail

if grep -RInE "/rp/volumes|/rp/secrets|/mnt/resourceportal-storage|CephFS Volume provisioning|device=:/rp" \
  .env.example packages/resourceportal-api/src packages/resourceportal-api/scripts \
  --exclude='migration.sql' --exclude-dir=node_modules; then
  echo "Legacy active storage path detected" >&2
  exit 1
fi

bash scripts/validate-swarm-ci.sh

test -d "${RESOURCE_VOLUME_RUNTIME_ROOT:-/mnt/resourceportal/volumes}"
NODE_ID="$(docker info --format '{{.Swarm.NodeID}}')"
test "$(docker node inspect "$NODE_ID" --format '{{index .Spec.Labels "rp.node.storage"}}')" = true
test "$(docker node inspect "$NODE_ID" --format '{{index .Spec.Labels "resourceportal.storage.volumes"}}')" = true

GPU_SCHEMA_STACK="rp-gpu-schema-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${BASHPID}"
GPU_SCHEMA_FILE="$(mktemp)"
GPU_SCHEMA_SERVICE="${GPU_SCHEMA_STACK}_gpu_schema"
cleanup_gpu_schema() {
  docker stack rm "$GPU_SCHEMA_STACK" >/dev/null 2>&1 || true
  rm -f "$GPU_SCHEMA_FILE"
}
trap cleanup_gpu_schema EXIT
RP_GPU_SCHEMA_NODE_ID="$NODE_ID" \
  npm --workspace @resource-portal/api exec -- \
  ts-node --files scripts/render-nvidia-gpu-stack-fixture.ts >"$GPU_SCHEMA_FILE"
docker stack config --compose-file "$GPU_SCHEMA_FILE" >/dev/null
if grep -q "named_resource_spec" "$GPU_SCHEMA_FILE"; then
  echo "Generated GPU stack still contains unsupported named_resource_spec" >&2
  exit 1
fi
grep -q "discrete_resource_spec" "$GPU_SCHEMA_FILE"
docker stack deploy --resolve-image never --compose-file "$GPU_SCHEMA_FILE" "$GPU_SCHEMA_STACK" >/dev/null
gpu_resources="$(docker service inspect "$GPU_SCHEMA_SERVICE" --format '{{json .Spec.TaskTemplate.Resources.Reservations.GenericResources}}')"
gpu_constraints="$(docker service inspect "$GPU_SCHEMA_SERVICE" --format '{{json .Spec.TaskTemplate.Placement.Constraints}}')"
grep -F -q '"Kind":"NVIDIA-GPU"' <<<"$gpu_resources"
grep -F -q '"Value":1' <<<"$gpu_resources"
grep -F -q "node.id == $NODE_ID" <<<"$gpu_constraints"
docker stack rm "$GPU_SCHEMA_STACK" >/dev/null
for _ in $(seq 1 30); do
  if ! docker service inspect "$GPU_SCHEMA_SERVICE" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if docker service inspect "$GPU_SCHEMA_SERVICE" >/dev/null 2>&1; then
  echo "GPU schema validation service did not clean up" >&2
  exit 1
fi
rm -f "$GPU_SCHEMA_FILE"
trap - EXIT

npm --workspace @resource-portal/api run smoke:stage14-storage-backend
npm --workspace @resource-portal/api run smoke:stage13-platform-infrastructure
npm --workspace @resource-portal/api run smoke:stage15-capacity
npm --workspace @resource-portal/api run smoke:stage16-operations
npm --workspace @resource-portal/api run smoke:stage11-quota-concurrency
npm run api:smoke:deploy
npm --workspace @resource-portal/api run smoke:stage9-ingress
npm --workspace @resource-portal/api run smoke:volume-lifecycle
