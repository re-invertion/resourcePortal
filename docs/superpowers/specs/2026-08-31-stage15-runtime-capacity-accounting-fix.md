# Stage 15 Runtime Capacity Accounting Fix

## Problem

PR #50 introduced concurrency-safe deployment admission based on the latest succeeded deployment snapshot and active admitted deployment snapshots. A direct runtime start can change an AppGroup or SingleApp from `Stopped` to `Running` and scale Docker Swarm without creating a new deployment snapshot. If the last succeeded snapshot remains `Stopped`, later deployment admission can incorrectly account zero demand for the now-running workload.

## Required behavior

- A direct AppGroup or SingleApp start must participate in the same global Stage 15 capacity admission lock as deployments.
- The runtime-state mutation to `Running` must commit only after capacity admission succeeds.
- Once that transaction commits, later admissions must count the runtime-start reservation even before the external Docker scale finishes.
- A runtime stop must not release capacity while observed replicas are still non-zero.
- Deployed CPU/memory resource specifications remain sourced from the latest succeeded deployment snapshot; pending draft resource edits are not treated as deployed resources.
- Active admitted deployments keep the existing implicit-reservation semantics and override the succeeded baseline.
- Docker Swarm remains the only scheduler; no node selection or placement constraints are introduced.

## Conservative runtime occupancy

For a succeeded deployment baseline, capacity uses deployed resource values from its snapshot and overlays current runtime state from the Resource Portal DB.

For each deployed SingleApp:

- when AppGroup and SingleApp runtime state are `Running`, reserve a conservative replica count covering deployed desired replicas, current desired replicas, and observed actual replicas;
- when either runtime state is `Stopped`, reserve observed actual replicas until they reach zero, then release the reservation;
- SingleApps not present in the succeeded deployment snapshot do not consume runtime capacity because they do not have a deployed Swarm service yet.

This is intentionally conservative: pending desired-replica changes may temporarily over-reserve capacity, but must never cause under-accounting or physical overcommit.

## Runtime admission boundary

A direct runtime start executes inside the existing AppGroup/SingleApp state transaction:

```text
pg_advisory_xact_lock("resourceportal:capacity:swarm")
→ load platform supply / health
→ load other workload reservations
→ load current succeeded deployment baseline
→ overlay requested RuntimeState.Running
→ validate StorageBackend readiness if Volumes are mounted
→ check projected CPU/RAM capacity
→ persist RuntimeState.Running
→ commit
→ scale Docker Swarm service(s)
```

After commit, the live runtime overlay is visible to all future admissions, so no separate reservation table is required.

## Errors

Runtime start uses the existing stable Stage 15 error model:

- `InsufficientCapacity` when projected CPU/RAM cannot fit;
- `PlatformUnavailable` when required Swarm or StorageBackend infrastructure is unavailable.

## Verification

Required tests:

- succeeded snapshot `Stopped` + live runtime `Running` is counted by deployment admission;
- runtime AppGroup start is rejected when projected capacity cannot fit;
- runtime SingleApp start is rejected when projected capacity cannot fit;
- rejection prevents the runtime-state mutation and Docker scale path;
- runtime stop remains reserved while `actualReplicas > 0` and releases after `actualReplicas = 0`;
- real Docker Swarm smoke starts a previously stopped workload and proves a conflicting deployment is rejected before stack apply.
