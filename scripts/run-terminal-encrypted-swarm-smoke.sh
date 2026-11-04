#!/usr/bin/env bash
# Real Docker Swarm network-driver proof for privileged node-agent transport.
# This uses a disposable network and never inspects or records live credentials.
set -euo pipefail
command -v docker >/dev/null
command -v jq >/dev/null
[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == active ]] || {
  echo "Terminal security smoke requires active Docker Swarm." >&2
  exit 1
}
name="rp-terminal-smoke-${GITHUB_RUN_ID:-local}-${BASHPID}"
cleanup() {
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# The Docker implementation must support encrypted non-attachable overlay
# networks before the full release can claim protected node-agent transport.
docker network create --driver overlay --opt encrypted "$name" >/dev/null
inspect="$(docker network inspect "$name")"
jq -e --arg name "$name" '
  length == 1 and .[0].Name == $name and
  .[0].Driver == "overlay" and .[0].Scope == "swarm" and
  .[0].Attachable == false and
  ((.[0].Options // {}) | has("encrypted") and
    (.encrypted == "" or .encrypted == "true"))
' <<<"$inspect" >/dev/null
echo "PASS: real Swarm supports verified encrypted non-attachable node-agent overlay."
