#!/usr/bin/env bash
# Physical NVIDIA / Docker Swarm gate. Run ONLY on a disposable single-node
# GPU test Swarm. Creates short-lived services and removes them on exit.
set -euo pipefail

if [[ "${RP_GPU_SMOKE_ACK:-}" != "isolated-nonproduction-swarm" ]]; then
  echo "BLOCKED: set RP_GPU_SMOKE_ACK=isolated-nonproduction-swarm on an isolated test Swarm" >&2
  exit 2
fi

for command in docker nvidia-smi grep sleep seq head tr wc; do
  command -v "$command" >/dev/null 2>&1 || { echo "BLOCKED: missing $command" >&2; exit 2; }
done

image="docker.io/library/ubuntu@sha256:2e863c44b718727c860746568e1d54afd13b2fa71b160f5cd9058fc436217b30"
node_id="$(docker info --format '{{.Swarm.NodeID}}')"
default_runtime="$(docker info --format '{{.DefaultRuntime}}')"

# Runner labels are not a security boundary. Reject production or multi-node
# Swarm before ANY pull or creation of a service.
[[ "$(docker info --format '{{.Swarm.ControlAvailable}}')" == true ]] || {
  echo "BLOCKED: test requires a dedicated Swarm manager" >&2; exit 2;
}
[[ "$(docker node ls --format '{{.ID}}' | wc -l)" == 1 ]] || {
  echo "BLOCKED: test must run on isolated single-node Swarm" >&2; exit 2;
}
[[ -z "$(docker service ls --format '{{.Name}}')" ]] || {
  echo "BLOCKED: existing Swarm services (possible production RP)" >&2; exit 2;
}
[[ "$default_runtime" == nvidia ]] || { echo "BLOCKED: Docker default runtime is not NVIDIA" >&2; exit 2; }
[[ "$node_id" =~ ^[a-z0-9]{20,40}$ ]] || { echo "BLOCKED: invalid local Swarm NodeID" >&2; exit 2; }

# Explicit physical identity is mandatory; no numeric GPU indexes.
gpu_uuids="$(nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits | tr -d '\r')"
gpu_count="$(printf '%s\n' "$gpu_uuids" | grep -c '^GPU-')"
[[ "$gpu_count" == 1 ]] || {
  echo "BLOCKED: isolated duplicate-capacity smoke requires exactly one physical GPU" >&2; exit 2;
}
uuid="$(printf '%s\n' "$gpu_uuids" | head -n 1)"
[[ "$uuid" =~ ^GPU-[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$ ]] || {
  echo "BLOCKED: nvidia-smi did not supply a physical GPU UUID" >&2; exit 2;
}
advertised="$(docker node inspect "$node_id" --format '{{json .Description.Resources.GenericResources}}')"
grep -F -q "$uuid" <<<"$advertised" || { echo "BLOCKED: GPU UUID not advertised as named Swarm resource" >&2; exit 2; }
grep -F -q '"Kind":"NVIDIA-GPU"' <<<"$advertised" || { echo "BLOCKED: expected NVIDIA-GPU named resource" >&2; exit 2; }

name="rp-gpu-smoke-$$"
gpu_service="${name}-gpu"
contender_service="${name}-contender"
cpu_service="${name}-cpu"
cleanup() {
  docker service rm "$gpu_service" "$contender_service" "$cpu_service" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image pull --quiet "$image" >/dev/null
docker service create --quiet --name "$gpu_service" \
  --constraint "node.id==$node_id" --restart-condition none \
  --replicas 1 --generic-resource "NVIDIA-GPU=1" \
  --env "NVIDIA_VISIBLE_DEVICES=$uuid" --env "NVIDIA_DRIVER_CAPABILITIES=utility,compute" "$image" \
  sh -c 'nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits; sleep 100' >/dev/null

# Check actual task visibility; scheduler reservation alone is insufficient.
gpu_container=""
for _ in $(seq 1 35); do
  gpu_container="$(docker ps -q --filter "label=com.docker.swarm.service.name=$gpu_service" | head -n1)"
  [[ -n "$gpu_container" ]] && break
  sleep 1
done
[[ -n "$gpu_container" ]] || { echo "FAIL: GPU-backed task did not become running" >&2; exit 1; }
seen="$(docker exec "$gpu_container" nvidia-smi --query-gpu=uuid --format=csv,noheader,nounits | tr -d '\r')"
[[ "$seen" == "$uuid" ]] || { echo "FAIL: GPU task did not exclusively see assigned UUID" >&2; exit 1; }

# On this deliberately single-GPU acceptance node, the discrete capacity unit
# MUST NOT be scheduled twice. Production UUID uniqueness is additionally
# enforced transactionally by ResourcePortal before any stack is rendered.
docker service create --quiet --name "$contender_service" \
  --constraint "node.id==$node_id" --restart-condition none \
  --replicas 1 --generic-resource "NVIDIA-GPU=1" \
  --env "NVIDIA_VISIBLE_DEVICES=$uuid" --env "NVIDIA_DRIVER_CAPABILITIES=utility,compute" "$image" sleep 100 >/dev/null
sleep 8
if docker ps -q --filter "label=com.docker.swarm.service.name=$contender_service" | grep -q .; then
  echo "FAIL: second workload received an already-reserved GPU" >&2
  exit 1
fi

# No GPU may be injected into a CPU-only container when NVIDIA is default runtime.
docker service create --quiet --name "$cpu_service" \
  --constraint "node.id==$node_id" --restart-condition none \
  --replicas 1 --env "NVIDIA_VISIBLE_DEVICES=void" "$image" \
  sh -c 'if ls /dev/nvidia[0-9]* >/dev/null 2>&1; then echo GPU_LEAK; exit 91; fi; echo CPU_ONLY_OK; sleep 40' >/dev/null
cpu_container=""
for _ in $(seq 1 35); do
  cpu_container="$(docker ps -q --filter "label=com.docker.swarm.service.name=$cpu_service" | head -n1)"
  [[ -n "$cpu_container" ]] && break
  sleep 1
done
[[ -n "$cpu_container" ]] || { echo "FAIL: CPU-only Swarm task did not become running" >&2; exit 1; }
if docker exec "$cpu_container" sh -c 'ls /dev/nvidia[0-9]* >/dev/null 2>&1'; then
  echo "FAIL: CPU-only task can access NVIDIA GPU devices" >&2; exit 1
fi
echo "PASS: $uuid exclusively visible; competing service unscheduled; CPU-only task isolated"
