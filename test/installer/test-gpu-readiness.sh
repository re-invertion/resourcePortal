#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/diagnostics.sh"

gpu_uuid="GPU-12345678-abcd-1234-abcd-123456789abc"
gpu_runtime=nvidia
advertise=yes
docker() {
  case "$*" in
    *"--format {{.DefaultRuntime}}"*) echo "$gpu_runtime" ;;
    *"--format {{.Swarm.NodeID}}"*) echo "ku2gbq2sm1b2khra543dtyxfg" ;;
    *"--format {{json .Description.Resources.GenericResources}}"*)
      if [[ "$advertise" == yes ]]; then
        printf '[{"NamedResourceSpec":{"Kind":"NVIDIA-GPU","Value":"%s"}}]\n' "$gpu_uuid"
      else
        echo 'null'
      fi ;;
    *) echo "FAIL: GPU preflight must be read-only, received docker $*" >&2; return 11 ;;
  esac
}
nvidia-smi() { echo "$gpu_uuid"; }
got="$(rp_nvidia_gpu_readiness)"
[[ "$got" == Candidate\ * ]] || { echo "Expected GPU candidate, got: $got" >&2; exit 1; }
gpu_runtime=runc
got="$(rp_nvidia_gpu_readiness)"
[[ "$got" == *"Docker default runtime"* ]] || exit 1
gpu_runtime=nvidia
advertise=no
got="$(rp_nvidia_gpu_readiness)"
[[ "$got" == *"UUID not advertised"* ]] || exit 1
advertise=yes
gpu_uuid=invalid
got="$(rp_nvidia_gpu_readiness)"
[[ "$got" == *"NVIDIA driver or GPU UUID"* ]] || exit 1
echo 'PASS: NVIDIA preflight is read-only and fail-closed'
