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
test "$(docker node inspect "$NODE_ID" --format '{{index .Spec.Labels "resourceportal.storage.volumes"}}')" = true

npm --workspace @resource-portal/api run smoke:stage14-storage-backend
npm --workspace @resource-portal/api run smoke:stage13-platform-infrastructure
npm --workspace @resource-portal/api run smoke:stage15-capacity
npm --workspace @resource-portal/api run smoke:stage16-operations
npm --workspace @resource-portal/api run smoke:stage11-quota-concurrency
npm run api:smoke:deploy
npm --workspace @resource-portal/api run smoke:stage9-ingress
npm --workspace @resource-portal/api run smoke:volume-lifecycle
