# NVIDIA GPU — Exclusive Allocation

Status: hardware acceptance **pending**. This change is eligible for the normal signed RP release after full pre-merge CI and DB rollback certification, **before** physical NVIDIA acceptance. A release is not proof of hardware isolation; the operator validates the actual host after updating.
Baseline: main after PR #349, SHA 52202280c92bb536080c5382e2de199dde93d21e.

## Contract

- A physical NVIDIA GPU is identified by GPU-UUID; it can belong to only one SingleApp in one tenant at a time.
- No MIG, sharing, or more than one replica of GPU-backed SingleApp.
- A platform admin authorizes GPU quota; quota reduction cannot go below active device reservations. A new tenant without any quota must receive complete CPU, memory, storage, maximum-app and volume limits in the same initial platform-admin grant (no invented defaults).
- Database enforces unique GPU and SingleApp assignments, with serialized reservation and readiness checks.
- Real node agent probes NVIDIA runtime in an immutable digest-pinned, unprivileged, read-only and networkless container, then its report must match UUIDs advertised by Swarm named generic resources.
- Missing, stale, malformed or failed probes never release current assignments.
- Worker checks exclusive UUID and single-replica state in deployment snapshots. Swarm named generic resource NVIDIA-GPU reserves exact UUID.
- Workloads without GPUs receive NVIDIA_VISIBLE_DEVICES=void. GPU workloads receive only the exclusive UUID.
- Draft discard checks all persisted rollout snapshots: any failed attempt containing the GPU SingleApp ID, or an invalid snapshot, retains the reservation rather than risking a still-running orphan task.
- GPU is released after successful stack --prune and rollout has verified no removed service remains; draft-only applications may be discarded before any deployment.
- GPU-backed SingleApps cannot be renamed while assigned to a physical UUID; their Swarm service identity remains stable until cleanup.
- Before successful rollout cleanup frees GPU reservations for deleted SingleApps, Swarm must confirm globally that their old services are absent, every node is Ready/Active, and all matching GPU tasks are terminal. Otherwise the rollout enters the failure/rollback path with the reservation retained.
- Deleting an entire App Group also requires that every Swarm node is Ready/Active and that all stack services and nonterminal tasks are absent before the GPU reservation is released inside the same DB transaction as the final group deletion.
- The tenant MCP quota endpoint is read-only. Only Platform Admin may grant or change hard tenant GPU quotas; the separate Admin MCP exposes an audited quota operation.
- Tenant API, Tenant MCP, SDK and CLI use the same tenant RBAC. Platform Admin Infrastructure displays hardware inventory and assignment status; Platform Admin MCP exposes separate list_gpu_devices and set_tenant_gpu_quota operations through platform-scoped APIs only, without tenant workloads. Integration tests verify correct OAuth bearer forwarding, paths and audited mutations.

## Host preconditions

1. Host NVIDIA driver and nvidia-smi work and expose real GPU-UUID.
2. NVIDIA Container Toolkit is installed; Docker default runtime on each GPU node is nvidia and Docker --gpus=all can run the immutable pinned probe image. This is required because Swarm named generic resources schedule tasks but do not select a container runtime.
3. Docker daemon advertises actual UUIDs via node-generic-resources with kind NVIDIA-GPU; labels alone are untrusted.
4. Installer diagnostics run a read-only NVIDIA host preflight and report driver, default runtime and Swarm named UUID resource state. It never changes Docker or installs drivers, does not block CPU-only installs and does not certify GPU isolation without the runtime probe.
5. Never silently restart Docker to configure a live single-node Swarm. Such a restart requires a maintenance window and recovery plan.
6. Test physical GPU isolation in actual Swarm: two tenant apps competing for the same GPU and a CPU-only app without GPU access.

## Release safety

- The Prisma table is a schema migration. The existing CI supports candidate-specific real-upgrade-and-restore certification, including old API+PostgreSQL+ZITADEL recovery, and this migration passes expand-only SQL review. This is not yet candidate-specific CI evidence. A release is blocked without the exact workflow proof; never substitute a locally fabricated evidence file.
- Do not claim image-only rollback for this change, bypass merge queue or omit mandatory fault injection. Hardware-specific NVIDIA runtime tests are explicitly **post-release acceptance**, not a pre-merge CI condition. They are not claimed as passed, and failures are handled by follow-up fixes and a new signed release.
- Readiness, rollback from immediate published release, signed release manifest, images, tag, full CI and tenant production access must be verified.
- The RP Admin inventory queried while implementing reported GPU count zero. This is not proof that hardware is absent, but it is not physical-GPU test evidence.
- Do not mark Wiki Implementation Stages GPU steps as fully hardware-verified until both signed release and real user acceptance tests pass.


## Optional post-release physical GPU CI runner

ResourcePortal Release Readiness runs normal mandatory checks (full regression, Swarm, installer, OIDC/federation as applicable, **real database upgrade/restore and automatic rollback**). Hardware-specific NVIDIA acceptance is intentionally moved to a separately triggered post-release workflow, not treated as a pre-merge runner requirement.
The smoke refuses to run if the node is not a single-node Swarm manager, the
acknowledgement is missing, or any existing Swarm service is detected.
The nonproduction safety invariant is tested in
test/installer/test-gpu-swarm-gate-safety.sh.
The job must pass on a dedicated disposable Swarm node with GitHub runner
labels: self-hosted, linux, x64, rp-isolated-nvidia-gpu.
Never install this CI runner on the production RP manager. It deploys and removes
short-lived Swarm services to prove single-device scheduling, actual UUID visibility,
and GPU denial to CPU-only tenants.
The script requires RP_GPU_SMOKE_ACK=isolated-nonproduction-swarm in CI.
The physical GPU job is invoked manually **after** the signed release using `.github/workflows/nvidia-gpu-physical.yml` and a published release tag. No NVIDIA hardware result is implied by the signing or publication of RP.
Provision this separate test runner with NVIDIA kernel driver, Container Toolkit,
default NVIDIA runtime and actual NVIDIA-GPU UUID generic resources in Swarm.

### Evidence still needed

- After updating the real RP environment: confirm GPU host driver, container toolkit, default NVIDIA runtime, node generic resource UUID and tenant quota UI/MCP, then test one dedicated GPU application; verify a second tenant is denied and CPU-only apps cannot access the GPU. Report any failure for a follow-up fix and signed patch release.
- Before publishing: complete candidate CI, isolated DB upgrade-and-restore, merge queue and exact-SHA signed release. Do not make the physical NVIDIA job a prerequisite for this first release.
- Production GPU placement and CPU-only runtime verification after a safe update, with recording of observed GPU UUID, tenant allocations and deployment states. Never run the isolated smoke script on the live RP cluster: it intentionally creates/removes disposable services.
- Never restart Docker on the production manager outside an approved maintenance window.
