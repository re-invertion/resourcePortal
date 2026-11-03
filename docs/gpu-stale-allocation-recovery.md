# GPU stale allocation recovery (#378)

ResourcePortal treats a dedicated NVIDIA GPU as an **exclusive physical reservation**.
An absent container alone is **not** proof that a GPU is free: a Swarm service
may still recreate a task, an agent may be unreachable, or another workload
may hold the same GPU. Never edit the GPU allocation row manually.

## Diagnosis (platform administrator)

The platform admin APIs enqueue auditable Worker operations, not live Docker
commands in the HTTP/API process:

- `POST /platform/gpu-devices/<GPU-UUID>/diagnose` — operation `SWARM_GPU_DIAGNOSE`.
- `POST /platform/gpu-devices/<GPU-UUID>/recover` with JSON
  `{"releaseIfUnavailable":false}` — `SWARM_GPU_RECOVER`: refreshes full Swarm
  inventory and authenticated node probe. If trusted GPU capacity is restored,
  the same SingleApp retains its original allocation. It can then deploy again.
- `POST /platform/gpu-devices/<GPU-UUID>/recover` with
  `{"releaseIfUnavailable":true}` — **explicit, potentially destructive**
  recovery attempt if the GPU remains unverified, available only after
  the original App Group **and** SingleApp have been stopped.

Poll the returned operation through the platform Operations API/UI. Review
`reasonCodes` and the operation status before taking corrective action.

Common reasons: `NvidiaNamedGenericResourceMissing` means Docker node
`Description.Resources.GenericResources` lacks a matching
`NVIDIA-GPU=<UUID>`; `NvidiaNotDefaultRuntime` means Docker's default
runtime is not `nvidia`; `GpuProbeImageNotInstalled` means the immutable
probe image must be preloaded; `NvidiaRuntimeProbeFailed` means the
authenticated `nvidia-smi` runtime probe failed;
`GpuProbeUuidMismatch` means the probe did not observe that specific GPU.
The administrator must repair the underlying node/runtime configuration;
a recovery request does not reconfigure the host or invent GPU capacity.

## Fail-closed release conditions

The Worker must verify **all** Docker Swarm nodes Ready and Active; every node
must return one unique authenticated node-local container report; neither
a running container using the UUID nor an unknown/all-GPU allocation may
exist; the Swarm service inventory must contain no service capable of
rescheduling an NVIDIA-GPU task; the original App Group and SingleApp must
be stopped; no deployment may be running. Database changes are serialized
under the GPU advisory lock, compare-and-swap and audited.

Unreachable/duplicate agents, malformed Docker records, failed inspection,
an active deployment, other occupied GPUs, or a live GPU service all reject
release. The operation does **not** force-kill tasks or silently assign the
GPU to another tenant. If release succeeds, the SingleApp GPU draft is set
to zero; the administrator must repair host GPU verification, then explicitly
reserve the UUID again and deploy through the normal validated flow.

The Runtime Drift Worker corroborates manager replica counts with an
authenticated node-local GPU task census. A missing GPU task overrides a stale
1/1 manager summary as `actualReplicas=0`/`Unhealthy`; unknown probe
evidence is marked `Unknown`, never reported as verified healthy.

## Validation and rollout

This is a schema-neutral patch. CI must run the complete ResourcePortal
release readiness, GPU-security Fast Fix profile, isolated real Swarm smoke,
published-source automatic rollback verification, protected Merge Queue and
signed official release. New APIs require platform-admin privileges. Do not
manually bypass the release safety gates or change allocation rows.
