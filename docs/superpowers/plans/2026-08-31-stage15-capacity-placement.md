# Stage 15 Capacity / Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add concurrency-safe platform health and compute capacity admission before Docker Swarm deployment execution while keeping Swarm as the only scheduler.

**Architecture:** A focused `capacity` subsystem computes snapshot demand, loads Stage 13 Swarm supply and existing/admitted workload reservations, checks referenced Stage 14 storage backends, and performs admission under a global PostgreSQL advisory lock. `DeploymentWorkerService` calls it when moving from `Validating` to `PreparingArtifacts`; the capacity decision and phase transition share one transaction.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Docker Swarm, Jest.

**Spec:** `docs/superpowers/specs/2026-08-31-stage15-capacity-placement-design.md`

## Global Constraints

- Docker Swarm remains the only container placement scheduler.
- No tenant-selectable node, affinity, or placement constraints.
- Compute admission uses `RemoteLocation.availableCpuNano` and `availableMemoryBytes`.
- Storage create/grow reservation remains Stage 14 responsibility.
- Retry/backoff remains Stage 16.
- Capacity arithmetic uses bigint for NanoCPU and bytes.

---

### Task 1: Capacity math and error model

**Files:**
- Create: `packages/resourceportal-api/src/capacity/capacity.logic.ts`
- Create: `packages/resourceportal-api/src/capacity/capacity.logic.spec.ts`
- Create: `packages/resourceportal-api/src/capacity/capacity-errors.ts`

**Interfaces:**
- Produces `snapshotDemand(snapshot): { cpuNano: bigint; memoryBytes: bigint }`.
- Produces `projectedCapacityFits(supply, occupied, requested)`.
- Produces error codes `InsufficientCapacity` and `PlatformUnavailable`.

- [ ] Write tests proving CPU decimal → NanoCPU bigint conversion, stopped replicas → zero, and projected capacity overflow.
- [ ] Run API Jest suite and confirm RED because the capacity module does not exist.
- [ ] Implement the minimal pure logic and error constants.
- [ ] Run targeted Jest tests and confirm GREEN.
- [ ] Commit.

### Task 2: Concurrency-safe admission service

**Files:**
- Create: `packages/resourceportal-api/src/capacity/capacity-preflight.service.ts`
- Create: `packages/resourceportal-api/src/capacity/capacity-preflight.service.spec.ts`
- Create: `packages/resourceportal-api/src/capacity/capacity.module.ts`

**Interfaces:**
- Produces `CapacityPreflightService.admitDeployment(tx, deploymentId, snapshot)` returning `{ cpuNano, memoryBytes }` or a validation failure `{ errorCode, message }`.
- Uses `SELECT pg_advisory_xact_lock(hashtextextended('resourceportal:capacity:swarm', 0))`.

- [ ] Write tests for missing/unhealthy Swarm, degraded-but-capable Swarm, CPU/RAM shortage, succeeded deployment baseline, admitted active deployment replacement, and Validating not reserving.
- [ ] Run tests and confirm RED.
- [ ] Implement supply/reservation queries and admission calculation.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 3: Storage backend admission

**Files:**
- Modify: `packages/resourceportal-api/src/capacity/capacity-preflight.service.ts`
- Modify: `packages/resourceportal-api/src/capacity/capacity-preflight.service.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`

**Interfaces:**
- Capacity preflight checks every distinct backend used by deployment Volumes for `Ready`, no maintenance, writable health, and capacity metadata.
- Stage 14 storage capacity/platform exceptions use stable Stage 15 error codes.

- [ ] Write failing tests for unavailable/maintenance storage backend and stable storage error codes.
- [ ] Run tests and confirm RED.
- [ ] Implement storage checks and error-code exceptions without duplicating Volume reservation.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 4: Deployment worker atomic admission boundary

**Files:**
- Modify: `packages/resourceportal-api/src/internal/internal.module.ts`
- Modify: `packages/resourceportal-api/src/internal/deployment-worker.service.ts`
- Create: `packages/resourceportal-api/src/internal/stage15-capacity-admission.spec.ts`

**Interfaces:**
- `DeploymentWorkerService` injects `CapacityPreflightService`.
- On requested transition to `PreparingArtifacts`, existing snapshot validation runs first; capacity admission and the `Validating → PreparingArtifacts` update happen inside one Prisma transaction under the capacity lock.
- Failed admission records deployment `Failed` with `InsufficientCapacity` or `PlatformUnavailable` before artifact preparation/apply.

- [ ] Write failing worker test proving capacity rejection prevents transition and success transitions atomically.
- [ ] Run tests and confirm RED.
- [ ] Wire `CapacityModule` into `InternalModule` and worker transition.
- [ ] Run targeted tests and confirm GREEN.
- [ ] Commit.

### Task 5: Real Swarm regression and final verification

**Files:**
- Create: `packages/resourceportal-api/scripts/smoke-stage15-capacity.ts`
- Modify: `.github/workflows/swarm-integration.yml`

**Interfaces:**
- Smoke reconciles Stage 13 inventory, deploys a fitting workload, then submits an oversized deployment and verifies `InsufficientCapacity` before Docker stack apply.

- [ ] Add the Stage 15 smoke to the real Swarm workflow.
- [ ] Run full CI: dependency audit, Prisma generate, lint, test, build.
- [ ] Run Real Docker Swarm Integration and Live Federation Integration.
- [ ] Review changed files against every Stage 15 spec requirement.
- [ ] Open PR only after all verification is green.
