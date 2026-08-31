# Stage 13 Platform Infrastructure — Design

## Goal

Stage 13 makes the single Docker Swarm cluster and its nodes observable and administrable from Resource Portal without introducing a second placement engine or per-node agent.

Resource Portal remains the desired-state control plane. Docker Swarm remains the execution plane and owns placement, rescheduling and workload HA.

## Architectural decisions

- Resource Portal manages exactly one global Docker Swarm cluster.
- `RemoteLocation` means exactly one Docker Swarm node. No separate `SwarmNode` domain entity is introduced.
- RP talks to the Swarm manager through the existing `DOCKER_CONTEXT`; workers do not run an RP agent.
- Node inventory is discovered and reconciled from Docker Swarm.
- Tenant users do not choose a Remote Location during deployment.
- Docker Swarm remains responsible for task placement and rescheduling.
- RP exposes platform-level health, capacity and maintenance operations only.
- Missing nodes are retained as historical inventory and marked `Removed`; they are not silently deleted.
- Maintenance maps to Docker node availability: entering maintenance uses `drain`, leaving maintenance uses `active`.
- Cluster and Remote Location administration is platform-admin only.

## Data model

### SwarmCluster

A singleton platform record representing the currently configured global Swarm.

Fields:

- `id` — UUID primary key.
- `dockerClusterId` — Swarm cluster ID discovered from `docker info`.
- `health` — `Healthy | Degraded | Unhealthy | Unknown`.
- `managerCount` — number of manager nodes discovered in the last reconcile.
- `nodeCount` — number of non-removed nodes discovered in the last reconcile.
- `lastSyncedAt` — timestamp of last successful reconcile.
- `lastError` — last reconciliation error, cleared after a successful reconcile.
- timestamps.

There is no public create/delete lifecycle. Reconcile upserts the singleton by Docker cluster ID.

### RemoteLocation

A platform inventory record mapped 1:1 to a Docker Swarm node.

Fields:

- `id` — UUID primary key.
- `swarmNodeId` — unique Docker node ID.
- `hostname`.
- `role` — `Manager | Worker`.
- `status` — raw normalized node state: `Ready | Down | Unknown | Disconnected | Removed`.
- `availability` — `Active | Pause | Drain`.
- `health` — `Healthy | Degraded | Unhealthy | Unknown`.
- `maintenance` — RP maintenance flag; kept consistent with `availability=Drain` for RP-initiated maintenance.
- `cpuNano` — total node CPU expressed as Docker NanoCPUs.
- `availableCpuNano` — currently schedulable CPU capacity exposed by Stage 13.
- `memoryBytes` — total node memory.
- `availableMemoryBytes` — currently schedulable memory capacity exposed by Stage 13.
- `gpuCount` — GPU capacity inferred from deterministic node labels, default `0`.
- `networkCapabilities` — normalized string list inferred from deterministic node labels.
- `lastSeenAt` — timestamp of last successful observation of this node.
- timestamps.

Node IDs are authoritative identity. Hostname changes update the existing record.

Stage 13 defines `availableCpuNano` and `availableMemoryBytes` as **scheduler-available node capacity**, not as instantaneous operating-system free CPU or RAM. A `Ready/Active` node exposes its discovered total capacity as available; `Drain`, `Pause`, `Down`, `Disconnected`, `Unknown` and `Removed` expose zero available capacity. This keeps the manager-only architecture deterministic and avoids pretending that Docker Swarm manager inventory exposes live OS utilization. Stage 15 Capacity may refine allocatable capacity with reservations/usage without changing the Stage 13 identity model.

## Docker observation

The platform runtime adapter gains three focused operations:

1. `inspectSwarm()` — obtains cluster ID and basic manager state from Docker.
2. `listSwarmNodes()` — lists node IDs and summary state.
3. `inspectSwarmNode(nodeId)` — reads hostname, role, availability, status, resources and labels.

All commands reuse the existing Docker context and runtime timeout handling.

## Reconciliation

`SwarmInfrastructureService.reconcile()` performs:

1. inspect the configured Swarm;
2. list nodes;
3. inspect each node;
4. derive total and scheduler-available CPU/RAM capacity;
5. upsert `RemoteLocation` by `swarmNodeId`;
6. mark previously known but no-longer-listed nodes as `Removed` with zero available capacity;
7. derive cluster health;
8. upsert the singleton `SwarmCluster` record;
9. write audit events for material lifecycle or maintenance changes.

Health derivation:

- cluster `Healthy`: at least one manager and all observed nodes are Ready;
- cluster `Degraded`: at least one manager exists, but one or more nodes are not Ready;
- cluster `Unhealthy`: no manager is available or Docker reports the cluster unavailable;
- cluster `Unknown`: observation could not be completed.

Remote Location health:

- `Healthy` when status is Ready and availability is Active;
- `Degraded` when status is Ready but availability is Pause/Drain;
- `Unhealthy` when status is Down/Disconnected/Removed;
- otherwise `Unknown`.

## API

All routes use `PlatformAdminGuard`.

- `GET /api/platform/swarm-cluster` — current cluster snapshot; 404 before first successful reconcile.
- `POST /api/platform/swarm-cluster/reconcile` — run one reconciliation and return summary.
- `GET /api/platform/remote-locations` — list inventory ordered by hostname.
- `GET /api/platform/remote-locations/:id` — get one inventory record.
- `PATCH /api/platform/remote-locations/:id/maintenance` with `{ "enabled": boolean }` — call Docker node update (`drain` or `active`) and persist the resulting state only when Docker succeeds.

## Scheduling

A background reconciler runs on a configurable interval. `SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS` defaults to 30 seconds and must be a positive integer when set. The scheduler must not overlap runs.

## Audit

Audit entries are global (`tenantId = null`) and must not contain Docker credentials or environment secrets.

Events:

- `swarm.infrastructure.reconcile.failed`
- `remote-location.discovered`
- `remote-location.removed`
- `remote-location.maintenance.enabled`
- `remote-location.maintenance.disabled`

## Testing

Stage 13 requires:

- unit tests for health derivation, scheduler-available capacity and label capacity parsing;
- service tests for idempotent reconciliation, node removal, capacity persistence and maintenance failure semantics;
- controller access-policy coverage proving platform-admin protection;
- a real Docker Swarm smoke that confirms node discovery, total/available CPU/RAM, and `active -> drain -> active` lifecycle with available capacity changing accordingly;
- existing CI, Real Docker Swarm Integration and Live Federation Integration must remain green.

## Non-goals

- no per-node RP agent;
- no instantaneous OS free-CPU/free-RAM telemetry in Stage 13;
- no user-selectable placement;
- no custom placement engine;
- no multi-cluster abstraction;
- no generic Kubernetes/Nomad runtime adapter;
- no automatic removal of Docker nodes from the Swarm;
- no Proxmox/VM infrastructure model in Stage 13.
