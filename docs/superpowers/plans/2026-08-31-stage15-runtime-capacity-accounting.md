# Stage 15 Runtime Capacity Accounting Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Stage 15 P1 gap where workloads deployed as `Stopped` and later started directly can bypass or disappear from capacity accounting.

**Architecture:** Keep Docker Swarm as the only scheduler and preserve the Stage 15 global PostgreSQL advisory-lock namespace. Extend `CapacityPreflightService` so runtime starts are admitted under the same capacity lock before the runtime-state mutation commits, and make succeeded-deployment occupancy conservative by combining deployed resource specifications with current runtime state/replica observations. Active admitted deployments remain implicit reservations exactly as in Stage 15.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, Docker Swarm, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-stage15-capacity-placement-design.md`

## Global Constraints

- Docker Swarm remains the only container placement scheduler.
- No tenant-selectable node, affinity, or placement constraints.
- Compute admission uses `RemoteLocation.availableCpuNano` and `availableMemoryBytes`.
- Storage create/grow reservation remains Stage 14 responsibility.
- Retry/backoff remains Stage 16.
- Capacity arithmetic uses bigint for NanoCPU and bytes.
- Runtime start must not overcommit capacity and must become visible to later admission decisions as soon as the runtime-state transaction commits.
- Runtime stop must not release capacity before observed replicas have actually reached zero.

---

### Task 1: Reproduce the runtime-start accounting bug

**Files:**
- Modify: `packages/resourceportal-api/src/capacity/capacity-preflight.service.spec.ts`

**Interfaces:**
- Existing: `CapacityPreflightService.admitDeployment(tx, snapshot)`.
- New desired API: `CapacityPreflightService.admitRuntimeStart(tx, { appGroupId, singleAppId? })`.

- [ ] **Step 1: Add a failing baseline test** proving a succeeded snapshot with `appGroup.runtimeState = Stopped` is still counted after the live AppGroup is started.
- [ ] **Step 2: Add a failing runtime-admission test** proving a direct AppGroup/SingleApp start returns `InsufficientCapacity` when the projected running demand cannot fit.
- [ ] **Step 3: Run CI on the test-only commit** and confirm RED for the intended missing runtime-accounting behavior/API.

### Task 2: Implement conservative live runtime demand

**Files:**
- Modify: `packages/resourceportal-api/src/capacity/capacity-preflight.service.ts`
- Modify: `packages/resourceportal-api/src/capacity/capacity-preflight.service.spec.ts`

**Interfaces:**
- Produce `admitRuntimeStart(tx, { appGroupId, singleAppId? })` returning the same success/failure shape as deployment admission.
- Reuse the existing `resourceportal:capacity:swarm` transaction-scoped advisory lock.
- For the latest succeeded deployment, resources come from the immutable deployment snapshot; current DB runtime state plus `desiredReplicas`/`actualReplicas` determine conservative live occupancy.

- [ ] **Step 1: Load the latest succeeded deployment snapshot for runtime admission.** If no succeeded deployment exists, runtime start has no deployed service to scale and reserves zero.
- [ ] **Step 2: Load current AppGroup and matching SingleApps.** Apply the requested start override before calculating demand.
- [ ] **Step 3: Calculate conservative replica demand.** While runtime is Running, reserve at least deployed desired replicas, current desired replicas, and observed actual replicas; while runtime is Stopped, keep observed actual replicas reserved until they reach zero.
- [ ] **Step 4: Use this live demand for succeeded baselines in `occupiedCapacity()`.** Keep active admitted deployment reservations unchanged.
- [ ] **Step 5: Reuse platform health and StorageBackend checks for runtime start.** Return `InsufficientCapacity` / `PlatformUnavailable` consistently.
- [ ] **Step 6: Run targeted capacity tests and confirm GREEN.**

### Task 3: Put runtime start behind the Stage 15 admission boundary

**Files:**
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.module.ts`
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/app-groups/stage3-app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/app-groups/stage11-app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/capacity/capacity.module.ts` only if provider exports require adjustment.
- Add/modify focused runtime-capacity tests under `packages/resourceportal-api/src/capacity/` or `src/app-groups/`.

**Interfaces:**
- `AppGroupsService` receives `CapacityPreflightService` through DI.
- Before committing `RuntimeState.Running`, `updateAppGroupRuntimeState()` calls `admitRuntimeStart(tx, { appGroupId })`.
- Before committing a SingleApp `RuntimeState.Running`, `updateSingleAppRuntimeState()` calls `admitRuntimeStart(tx, { appGroupId, singleAppId })`.
- Capacity rejection throws the stable Stage 15 API exception and prevents Docker scale execution.

- [ ] **Step 1: Add a failing service-level test** proving rejected runtime admission prevents the Running-state mutation / scale path.
- [ ] **Step 2: Wire `CapacityModule` into `AppGroupsModule` and pass `CapacityPreflightService` through the Stage3/Stage11 constructor chain.**
- [ ] **Step 3: Call runtime admission inside the existing Prisma transaction before the Running-state update.**
- [ ] **Step 4: Map failed admission to `insufficientCapacityException()` or `platformUnavailableException()`.**
- [ ] **Step 5: Run targeted tests and confirm GREEN.**

### Task 4: Real regression and final verification

**Files:**
- Modify: `packages/resourceportal-api/scripts/smoke-stage15-capacity.ts` if needed to cover direct runtime start.
- Modify: Wiki `Implementation Stages` after merge.

**Interfaces:**
- Real Swarm smoke deploys a workload as Stopped, starts it through the runtime API, then proves a conflicting oversized deployment is rejected before stack apply.

- [ ] **Step 1: Add the direct-runtime-start regression to the Stage 15 real Swarm smoke.**
- [ ] **Step 2: Run CI: dependency audit, Prisma generate, lint, test, build.**
- [ ] **Step 3: Run Real Docker Swarm Integration and Live Federation Integration.**
- [ ] **Step 4: Open and merge the fix PR only after all verification is green.**
- [ ] **Step 5: Resolve the original PR #50 P1 review thread with the fix PR reference.**
- [ ] **Step 6: Update Wiki Stage 15 to ✅ and record the final verified head, merge commit, workflows, and runtime-start regression evidence.**
