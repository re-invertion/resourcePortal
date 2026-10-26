#!/usr/bin/env bash
set -euo pipefail
# Isolated Swarm contract smoke. Never change host sysctls or customer LAN.
name="rp-gateway-sysctl-smoke-$GITHUB_RUN_ID"
network="resourceportal-smoke-control-plane"
cleanup() {
  docker service rm "$name" >/dev/null 2>&1 || true
  for attempt in $(seq 1 30); do
    if ! docker service inspect "$name" >/dev/null 2>&1; then break; fi
    sleep 1
  done
}
trap cleanup EXIT

docker network inspect "$network" >/dev/null
docker service create --name "$name" --replicas 1 --detach=false \
  --network "$network" alpine:3.20 sleep 300 >/dev/null
# The same Docker Swarm update API used by GateRuntimeReconcilerService.
docker service update --detach=false --sysctl-add net.ipv4.ip_forward=0 "$name" >/dev/null
spec="$(docker service inspect "$name" --format '{{json .Spec.TaskTemplate.ContainerSpec.Sysctls}}')"
jq -e '."net.ipv4.ip_forward" == "0"' <<<"$spec" >/dev/null

container=""
for attempt in $(seq 1 30); do
  container="$(docker ps --quiet --filter "label=com.docker.swarm.service.name=$name" | head -n 1)"
  if [[ -n "$container" ]] && [[ "$(docker inspect "$container" --format '{{.State.Running}}')" == "true" ]]; then
    break
  fi
  container=""
  sleep 1
done
[[ -n "$container" ]] || { echo "Gateway sysctl smoke task did not converge" >&2; exit 1; }
[[ "$(docker exec "$container" cat /proc/sys/net/ipv4/ip_forward)" == "0" ]] ||
  { echo "Swarm task namespace forwarding was not disabled" >&2; exit 1; }
echo "Swarm task-scoped net.ipv4.ip_forward=0 verified"
