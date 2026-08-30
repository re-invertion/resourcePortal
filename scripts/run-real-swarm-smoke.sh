#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate-swarm-ci.sh
npm --workspace @resource-portal/api run smoke:stage11-quota-concurrency
npm run api:smoke:deploy
npm --workspace @resource-portal/api run smoke:stage9-ingress
npm --workspace @resource-portal/api run smoke:volume-lifecycle
npm --workspace @resource-portal/api run smoke:stage13-platform-infrastructure
