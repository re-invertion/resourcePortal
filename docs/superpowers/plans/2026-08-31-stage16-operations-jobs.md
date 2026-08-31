# Stage 16 Operations / Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable DB-backed Operations/Jobs layer, migrate Volume and Domain long-running mutations to queued execution, and adapt AppGroupDeployment into the common operation lifecycle without rewriting the stable deployment engine.

**Architecture:** A new `operations` module owns persistence, API, executor registry, retry policy and the generic operation worker. Existing domain services remain the single source of side-effect logic. AppGroupDeployment is mirrored/adapted into Operations while the Stage 6 worker remains the actual deployment executor.

**Tech Stack:** NestJS 11, TypeScript 5.9, Prisma 6.12 raw PostgreSQL SQL, Vitest, GitHub Actions, Docker Swarm.

**Spec:** `docs/superpowers/specs/2026-08-31-stage16-operations-jobs-design.md`

## Global Constraints

- Do not rewrite the Stage 6 AppGroup deployment rollout engine.
- Docker Swarm remains the only container scheduler.
- Traefik remains responsible for ACME and certificate private keys.
- Preserve separate resource and Operation lifecycles.
- Preserve existing stable Stage 14/15 error contracts.
- Use DB-backed queue/lease/heartbeat; no external message broker.
- Use TDD: each production behavior must be preceded by a failing test.

---

### Task 1: Operations persistence and retry policy

**Files:**
- Create: `packages/resourceportal-api/prisma/migrations/20260831160000_stage16_operations/migration.sql`
- Create: `packages/resourceportal-api/src/operations/operation.types.ts`
- Create: `packages/resourceportal-api/src/operations/operation-retry.ts`
- Create: `packages/resourceportal-api/src/operations/operation-retry.spec.ts`
- Create: `packages/resourceportal-api/src/operations/operations.repository.ts`
- Create: `packages/resourceportal-api/src/operations/operations.repository.spec.ts`

**Interfaces:**
- Produces `OperationRecord`, `OperationType`, `OperationStatus`, `OperationRepository` and `computeRetryDelayMs(attempt)`.
- Repository supports create/list/get/events/claim/heartbeat/succeed/fail/retry and deployment-adapter synchronization.

- [ ] Write retry and repository tests first.
- [ ] Run CI on the RED commit and verify failure is due to missing production implementation.
- [ ] Add migration, types, retry and repository implementation.
- [ ] Re-run affected tests and Prisma generate/build.
- [ ] Commit GREEN implementation.

### Task 2: Executor contract and generic worker

**Files:**
- Create: `packages/resourceportal-api/src/operations/operation-executor.ts`
- Create: `packages/resourceportal-api/src/operations/operation-executor-registry.ts`
- Create: `packages/resourceportal-api/src/operations/operation-executor-registry.spec.ts`
- Create: `packages/resourceportal-api/src/operations/operations-worker.service.ts`
- Create: `packages/resourceportal-api/src/operations/operation-worker.runner.ts`
- Modify: `packages/resourceportal-api/package.json`

**Interfaces:**
- `OperationExecutor.execute(operation): Promise<OperationExecutionResult>`.
- `OperationExecutorRegistry.resolve(type)` returns a registered executor.
- `OperationsWorkerService.processNext(workerId, leaseSeconds)` handles claim, heartbeat, execute, success/failure/retry.

- [ ] Write registry/worker tests first.
- [ ] Verify RED.
- [ ] Implement registry, worker service and runner.
- [ ] Add `worker:operations` package script.
- [ ] Verify GREEN.

### Task 3: Operations API and module wiring

**Files:**
- Create: `packages/resourceportal-api/src/operations/operations.controller.ts`
- Create: `packages/resourceportal-api/src/operations/operations.controller.spec.ts`
- Create: `packages/resourceportal-api/src/operations/operations.service.ts`
- Create: `packages/resourceportal-api/src/operations/operations.module.ts`
- Modify: `packages/resourceportal-api/src/app.module.ts`
- Modify: `packages/resourceportal-api/src/prisma/seed.ts`

**Interfaces:**
- Tenant API provides list/get/events/retry.
- `OperationsService.enqueue(...)` is used by domain controllers.
- Seed adds `operation.read` and `operation.retry` permissions to existing admin/operator role policy using existing seed patterns.

- [ ] Write controller/service tests first.
- [ ] Verify RED.
- [ ] Implement API/module/permissions.
- [ ] Verify GREEN and access-policy regressions.

### Task 4: Volume executors and async endpoints

**Files:**
- Create: `packages/resourceportal-api/src/operations/executors/volume-operation.executors.ts`
- Create: `packages/resourceportal-api/src/operations/executors/volume-operation.executors.spec.ts`
- Modify: `packages/resourceportal-api/src/volumes/volumes.controller.ts`
- Modify: `packages/resourceportal-api/src/volumes/volumes.module.ts`

**Interfaces:**
- Queue types: `VOLUME_CREATE`, `VOLUME_RESIZE`, `VOLUME_DELETE`.
- Executors delegate to the existing `VolumesService` methods.

- [ ] Write executor and controller behavior tests first.
- [ ] Verify RED.
- [ ] Change mutations to enqueue Operations.
- [ ] Register volume executors.
- [ ] Verify Stage 7/14 regressions remain green.

### Task 5: Domain verification executors and async endpoints

**Files:**
- Create: `packages/resourceportal-api/src/operations/executors/domain-operation.executors.ts`
- Create: `packages/resourceportal-api/src/operations/executors/domain-operation.executors.spec.ts`
- Modify: `packages/resourceportal-api/src/domains/domains.controller.ts`
- Modify: `packages/resourceportal-api/src/domains/domains.module.ts`

**Interfaces:**
- Queue types: `DOMAIN_VERIFY`, `CUSTOM_ROOT_DOMAIN_VERIFY`.
- Executors delegate to existing domain validation methods.

- [ ] Write executor and controller behavior tests first.
- [ ] Verify RED.
- [ ] Queue validation endpoints and register executors.
- [ ] Verify Stage 9 domain regressions remain green.

### Task 6: AppGroupDeployment adapter

**Files:**
- Create: `packages/resourceportal-api/src/operations/deployment-operation-adapter.service.ts`
- Create: `packages/resourceportal-api/src/operations/deployment-operation-adapter.service.spec.ts`
- Modify: `packages/resourceportal-api/src/app-groups/app-groups.service.ts`
- Modify: `packages/resourceportal-api/src/internal/deployment-audit.service.ts`

**Interfaces:**
- Deployment creation mirrors `APP_GROUP_DEPLOY` / `APP_GROUP_ROLLBACK` operations with `input.deploymentId`.
- Deployment terminal audit synchronization updates the mirrored Operation to Succeeded/Failed/RolledBack/RollbackFailed.

- [ ] Write adapter tests first.
- [ ] Verify RED.
- [ ] Insert mirrored operation in the same deployment creation transaction.
- [ ] Synchronize terminal outcomes without changing rollout execution.
- [ ] Verify Stage 6 and Stage 15 deployment regression tests.

### Task 7: Domain event bus and operation lifecycle events

**Files:**
- Create: `packages/resourceportal-api/src/operations/operation-event-bus.ts`
- Create: `packages/resourceportal-api/src/operations/operation-event-bus.spec.ts`
- Modify: `packages/resourceportal-api/src/operations/operations-worker.service.ts`

**Interfaces:**
- Lightweight in-process subscribe/publish API for operation lifecycle notifications.
- Persistence in OperationEvent remains authoritative; event bus is best-effort process-local decoupling only.

- [ ] Write event-bus test first.
- [ ] Verify RED.
- [ ] Implement and wire lifecycle publication.
- [ ] Verify GREEN.

### Task 8: Real integration smoke and documentation

**Files:**
- Create: `packages/resourceportal-api/scripts/smoke-stage16-operations.ts`
- Modify: `packages/resourceportal-api/package.json`
- Modify: `.github/workflows/swarm-integration.yml`
- Modify: `docs/wiki-compliance.md`

**Interfaces:**
- Smoke verifies migration, enqueue/claim/execute lifecycle, idempotency, retry scheduling and at least one real infrastructure-backed operation while preserving deployment smoke.

- [ ] Add Stage 16 smoke assertions.
- [ ] Run CI, Real Docker Swarm Integration and Live Federation Integration on the exact final head.
- [ ] Fix any regression through test-first changes.
- [ ] Record exact final head and workflow IDs in PR body.

### Task 9: Review, merge and Wiki completion

**Files:**
- GitHub PR and ResourcePortal Wiki documents.

- [ ] Review PR diff and inline review threads.
- [ ] Verify exact final head has all required green workflows.
- [ ] Merge PR to `main` using expected head SHA.
- [ ] Update `Operations / Jobs` and `Implementation Stages` Wiki pages from merged facts only.
- [ ] Cross-check relevant ResourcePortal Wiki pages and mark Stage 16 complete only after merge verification.
