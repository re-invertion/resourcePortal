# Stage 15 Capacity / Placement — Design

## Goal

Stage 15 adds a lightweight platform admission check before infrastructure execution. Resource Portal does not choose Docker Swarm nodes: Docker Swarm remains the only container scheduler and owns placement, rescheduling, and workload HA.

The pipeline is:

```text
Quota
→ Capacity / Platform Health
→ Execute
→ Docker Swarm placement
```

## Architectural decisions

- No custom RP placement engine.
- No tenant-selectable node or placement constraints.
- Compute capacity uses Stage 13 `RemoteLocation` inventory.
- Storage capacity remains owned by Stage 14 `StorageBackend`; Stage 15 reuses its health/capacity semantics instead of duplicating storage reservation.
- Deployment admission is concurrency-safe through one PostgreSQL transaction-scoped advisory lock for the global Swarm capacity namespace.
- Active admitted deployments reserve capacity implicitly through their deployment phase; no new reservation table is introduced.
- Retry/backoff for transient failures remains Stage 16 Operations / Jobs.

## Compute supply

Compute supply is the sum of `availableCpuNano` and `availableMemoryBytes` from schedulable `RemoteLocation` records. Stage 13 already exposes zero available capacity for drained, paused, unavailable, or removed nodes.

Platform health rules:

- missing/unreconciled Swarm cluster → `PlatformUnavailable`;
- cluster health `Unknown` or `Unhealthy` → `PlatformUnavailable`;
- no schedulable RemoteLocation → `PlatformUnavailable`;
- cluster `Healthy` or `Degraded` may admit deployments if remaining CPU/RAM capacity is sufficient.

## Compute demand

Deployment demand is derived from the deployment snapshot:

- CPU = `SingleApp.cpu × effectiveReplicas`, converted to Docker NanoCPU as bigint;
- memory = `SingleApp.memoryBytes × effectiveReplicas`;
- stopped AppGroup or SingleApp contributes zero replicas;
- GPU remains outside the Stage 15 MVP and existing `GpuNotAvailable` validation stays authoritative.

## Existing workload usage and reservations

Capacity admission must account for workloads that already occupy the Swarm and for concurrent deployments.

For every other AppGroup, the baseline is its most recent `Succeeded` deployment snapshot.

If an AppGroup has an active admitted deployment in `Deploying` status at phase `PreparingArtifacts`, `GeneratingStack`, `ApplyingStack`, `WaitingForRollout`, or `Cleanup`, that active deployment snapshot replaces the last succeeded snapshot for capacity accounting.

The deployment currently being admitted replaces its own AppGroup baseline instead of being added to it, preventing double counting during updates.

A deployment in `Validating` has not reserved capacity yet.

## Concurrency

The transition `Validating → PreparingArtifacts` is the reservation boundary.

The worker executes capacity admission and the phase transition in the same database transaction while holding a global advisory lock:

```text
pg_advisory_xact_lock("resourceportal:capacity:swarm")
→ load platform supply
→ load admitted/baseline workload demand
→ calculate projected demand
→ accept or fail
→ transition to PreparingArtifacts
→ commit
```

This serializes concurrent admission decisions without adding a reservation table.

## Storage health during deployment

If the snapshot mounts Volumes, all referenced `StorageBackend` records must be writable at admission time:

- status `Ready`;
- maintenance `false`;
- health `Healthy` or `Degraded`;
- capacity metadata present.

Physical storage capacity reservation for Volume create/grow remains Stage 14 responsibility.

## Error model

Two stable capacity-layer error codes are used:

- `InsufficientCapacity` — platform is available but projected CPU/RAM or storage growth cannot fit;
- `PlatformUnavailable` — required platform infrastructure is unavailable, unhealthy, unreconciled, or in maintenance.

Existing storage write checks should use these codes consistently where they represent capacity/platform availability failures.

## Testing

Required coverage:

- pure demand/supply math with bigint NanoCPU and memory;
- stopped workloads contribute zero;
- unhealthy/unknown platform blocks admission;
- degraded platform with sufficient capacity is admitted;
- projected CPU/RAM overflow returns `InsufficientCapacity`;
- active admitted deployment replaces previous AppGroup baseline;
- `Validating` deployment does not reserve capacity;
- Volume-backed deployment checks StorageBackend writable state;
- worker admission is performed atomically with `Validating → PreparingArtifacts`;
- real Docker Swarm smoke proves a normal deployment passes Stage 15 admission and a deliberately oversized deployment fails before stack apply.

## Non-goals

- custom container scheduler;
- tenant node selection;
- affinity/anti-affinity;
- live OS free CPU/RAM telemetry;
- GPU placement;
- retry/backoff after capacity failure;
- VM/Proxmox placement.