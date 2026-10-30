Hybrid Capacity Manager extends Stage 15 compute admission so RAM hard limits are not treated as instantaneous physical consumption.

## Operating modes

- **Hybrid** is the default operating mode. CPU, GPU, tenant quota, storage-capacity and rollback protections remain unchanged.
- **Strict** preserves the pre-existing declared-reservation check and is also the fail-safe fallback whenever Hybrid cannot prove a safe decision.

Hybrid does not remove Docker memory limits. Every service still receives its configured Docker hard memory limit.

## Three independent memory values

Hybrid deliberately keeps these concepts separate:

1. **Hard limit** — the Docker memory ceiling for a service.
2. **Predicted demand** — a deterministic forecast based on real application usage, startup peaks and historical percentiles.
3. **Physical safety reserve** — RAM that Hybrid refuses to consume through new predicted growth.

The admission formula starts from fresh host `MemAvailable`. Existing physical use is already reflected in `MemAvailable`, so the algorithm subtracts only predicted **additional growth**, requested predicted demand and active deployment reservations. It never subtracts the full current application usage a second time.

## Telemetry

The worker records samples every 30 seconds by default. Application identity comes from the stable `resourceportal.single-app-id` workload label, not the container ID.

Sources are collected by the existing authenticated Swarm-global `terminal-agent` on every node. The capacity endpoint accepts no caller-supplied command, path, container, or process selector. Sources are:

- host `MemTotal` and `MemAvailable` from read-only host `/proc`;
- host Memory PSI;
- Docker live container memory usage;
- cgroup v2 `memory.current`, `memory.peak`, `memory.events` and `memory.pressure` resolved from the container PID through read-only host cgroup mounts;
- container start time, replica identity and OOM counters.

A container restart creates a new container identity. Historical peaks remain historical evidence, while the current sample and cgroup counters come from the new container instance.

### Persistence and retention

Full-resolution telemetry is stored as an append-only, versioned JSONL file under the existing ResourcePortal storage root:

`$RESOURCE_STORAGE_BASE_PATH/platform/capacity-manager-v1.jsonl`

Each sampling write is append-only and O(1). Once per hour the worker takes an inter-process lock, reloads the latest file, compacts old samples into bounded 5-minute/hourly buckets, writes a temporary file, and atomically renames it. A partial final JSONL line after a crash is ignored on recovery.

The current Capacity policy and the latest aggregate diagnostics snapshot are persisted through the existing `WorkerReconciliationState` PostgreSQL model. This lets the unprivileged API read diagnostics and update safe policy settings without mounting the storage-authoritative host path into the API container. No Prisma schema migration is introduced.

Retention is bounded:

| Window | Representation |
| --- | --- |
| 0–7 days | exact 30-second samples |
| 7–30 days | five-minute buckets retaining maxima, minimum available RAM and pressure maxima |
| 30–90 days | hourly buckets retaining rare peaks, OOM evidence and pressure maxima |
| >90 days | removed |

## Prediction model

Per application, Hybrid calculates:

- average;
- P95;
- P99;
- seven-day maximum;
- thirty-day maximum;
- ninety-day rare peak;
- startup peak during the first ten minutes after container start;
- 15% default application margin;
- confidence based on sample coverage and age.

For a brand-new application with no observations, the prediction is conservatively the requested hard limit with low confidence. For an already-running application, even the first fresh observation can be used with the safety margin, so Hybrid is useful from day one without pretending that a hard limit equals current physical use.

### Time correlation

A separate node sample stores the **same-time aggregate** of all RP application memory on that node. The 30-day node P99 therefore represents peaks that actually occurred together.

Hybrid combines:

- the sum of per-application predictions; and
- the same-time node P99 plus the application margin.

With mature telemetry, high confidence moves the forecast toward the observed same-time node profile. With incomplete telemetry, the result is deterministically blended back toward the conservative sum of application forecasts.

No LLM or probabilistic external service is involved.

## Admission control

Admission runs under the existing global PostgreSQL capacity advisory lock. This keeps deployment admission and the phase transition atomic.

For RAM, Hybrid:

1. refreshes telemetry;
2. validates telemetry freshness (90 seconds by default);
3. checks Swarm schedulability;
4. predicts additional growth of already-running workloads;
5. predicts the requested deployment or replica increase;
6. includes admitted deployments already in flight;
7. preserves the larger of 20% node RAM or the configured minimum system reserve;
8. blocks on high PSI pressure;
9. tightens the effective margin after OOM evidence.

CPU remains Strict. GPU exclusivity, tenant quotas, storage capacity checks and rollout/rollback reservations are unchanged.

### Fail-safe conditions

Hybrid falls back to Strict when:

- telemetry is stale or unavailable;
- host memory telemetry is incomplete;
- authenticated fresh node reports do not cover every schedulable Swarm node.

For multi-node Swarm, Hybrid evaluates every schedulable node separately and admits only if every node preserves its physical safety reserve after the requested and in-flight predicted growth. This is intentionally conservative for unconstrained Swarm placement: a missing node report never becomes an optimistic cluster-wide average.

## Configuration

Platform administrators can use **Platform → Infrastructure → Capacity & Predictions**.

Defaults:

- mode: Hybrid;
- telemetry interval: 30 s;
- exact history: 7 d;
- prediction window: 30 d;
- rare-event history: 90 d;
- percentile: P99;
- application margin: 15%;
- node safety buffer: 20%;
- maximum telemetry age: 90 s;
- minimum system reserve: 1 GiB.

The API validates safe ranges and persists the policy beside telemetry. The platform-admin guard protects both diagnostics and configuration.

Endpoints:

- `GET /api/platform/capacity`
- `PATCH /api/platform/capacity/settings`

Capacity errors expose aggregate numbers and the decision reason only; they do not identify other tenants or their applications.

## Rollout read model

After Docker rollout has been verified, deployment execution asks `RuntimeDriftReconcilerService` to reconcile that AppGroup immediately. The reconciler remains the only owner of `actualReplicas`, `observedAt`, observed image and runtime health fields. This closes the stale read-model case reported in issue #373 without bypassing the existing observed-state ownership rule.

## Issue #373 regression scenarios

Focused tests cover:

- Ollama RAM increases from 3 GiB to 3.25 GiB, 3.5 GiB and 4 GiB with sufficient physical/predicted headroom;
- speech service scaling from zero to one replica at 1.25 GiB;
- approximately 62.8 GiB physical RAM, approximately 17 GiB live use and hard limits near physical capacity;
- a 2 GiB Messenger Wrapper admission when forecast headroom remains safe;
- rejection under real memory pressure;
- parallel in-flight reservations;
- PSI and OOM safeguards;
- telemetry aging and bounded 7/30/90-day history;
- immediate post-rollout runtime reconciliation.

## Rollback

No Prisma migration is introduced. The append-only telemetry file and the two new reconciliation-state keys are additive runtime data that older releases ignore. Rolling back the ResourcePortal image therefore does not require a database restore specifically for Hybrid Capacity Manager. Release publication must still pass the repository's normal automatic rollback certification.