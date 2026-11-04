#!/usr/bin/env bash
# Validate that Docker STACK DEPLOY actually preserves data-plane encryption
# for a non-attachable node-agent network. Disposable resources only, no secrets.
set -euo pipefail
command -v docker >/dev/null
command -v jq >/dev/null
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == active ]] || {
  echo "Terminal security smoke requires active Docker Swarm." >&2
  exit 1
}
stack="rp-terminal-smoke-${GITHUB_RUN_ID:-local}-${BASHPID}"
network="${stack}_rp-terminal-secure"
service="${stack}_agent-network-proof"
fixture="$(mktemp)"
cleanup() {
  docker stack rm "$stack" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if ! docker network inspect "$network" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  rm -f "$fixture"
}
trap cleanup EXIT
# This fixture deliberately uses the same Compose network driver_opts as the
# production template. Do NOT substitute docker network create --opt encrypted:
# doing so would not catch stack deploy silently discarding Compose driver_opts.
cat >"$fixture" <<'YAML'
version: "3.9"
networks:
  rp-terminal-secure:
    driver: overlay
    attachable: false
    driver_opts:
      encrypted: "true"
services:
  agent-network-proof:
    image: busybox:1.36
    command: ["sleep", "60"]
    deploy:
      replicas: 0
    networks:
      - rp-terminal-secure
YAML
docker stack deploy --resolve-image never --compose-file "$fixture" "$stack" >/dev/null
inspect="$(docker network inspect "$network")"
jq -e --arg name "$network" '
  length == 1 and .[0].Name == $name and
  .[0].Driver == "overlay" and .[0].Scope == "swarm" and
  .[0].Attachable == false and
  ((.[0].Options // {}) | has("encrypted") and
    (.encrypted == "" or .encrypted == "true"))
' <<<"$inspect" >/dev/null
network_id="$(jq -r '.[0].Id' <<<"$inspect")"
docker service inspect "$service" | jq -e --arg id "$network_id" '
  length == 1 and
  (.[0].Spec.TaskTemplate.Networks | length == 1 and .[0].Target == $id)
' >/dev/null
echo "PASS: Docker stack deploy retained encrypted, non-attachable node-agent overlay and isolated service attachment."
