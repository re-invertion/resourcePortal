#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${RESOURCE_PORTAL_API_URL:?RESOURCE_PORTAL_API_URL is required}"
: "${SMOKE_USER_ID:?SMOKE_USER_ID is required}"

DOCKER_CONTEXT="${DOCKER_CONTEXT:-default}"

state="$(docker --context "$DOCKER_CONTEXT" info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}')"
if [[ "$state" != "active true" ]]; then
  echo "Docker context '$DOCKER_CONTEXT' is not an active Swarm manager: $state" >&2
  exit 1
fi

curl --fail --silent "${RESOURCE_PORTAL_API_URL%/}/health" >/dev/null

echo "Swarm CI preflight OK"
