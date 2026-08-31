# Stage 14 StorageBackend / CephFS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace host-local Volume storage assumptions with a platform-owned CephFS StorageBackend, enforce physical directory quotas and backend capacity, and render Docker Swarm volume access through NFS-Ganesha.

**Architecture:** A new `storage-backends` module owns backend persistence, CephFS command integration, backend telemetry and the NFS remote-access probe. `VolumesService` keeps tenant-facing lifecycle policy but delegates physical operations to `StorageBackendsService`. Deployment stack generation renders NFS driver options from persisted logical CephFS paths instead of pre-created bind volumes.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL, Vitest, Node.js filesystem/child_process APIs, Ceph CLI, CephFS xattrs, Docker Swarm CLI, NFSv4.x via NFS-Ganesha.

**Spec:** `docs/superpowers/specs/2026-08-31-stage14-storage-backend-design.md`

## Global Constraints

- MVP backend type is `CephFS` only.
- Common backend root is `/rp`; Volumes are `/rp/volumes/{tenantId}/{volumeId}` and secrets remain under `/rp/secrets`.
- NFS-Ganesha is access infrastructure, not another StorageBackend type.
- Volume shrink stays unsupported.
- Physical quota must be applied and read back before create/resize succeeds.
- Backend capacity and tenant quota are independent checks; storage overcommit is forbidden.
- `VolumeInUse`, cleanup-on-delete and symlink-safe used-size behavior from Stage 7 must not regress.
- Workload hosts must not require a direct CephFS host mount.

---

### Task 1: Persist StorageBackend and Volume association

**Files:**
- Modify: `packages/resourceportal-api/prisma/schema.prisma`
- Create: `packages/resourceportal-api/prisma/migrations/20260831102000_stage14_storage_backend/migration.sql`

**Interfaces:**
- Produces Prisma `StorageBackend`, `StorageBackendType`, `StorageBackendStatus` and required `Volume.storageBackendId` relation.

- [ ] **Step 1:** Add a schema contract test that imports the generated enums/model-facing code required by Stage 14 and fails before schema generation.
- [ ] **Step 2:** Run CI on the test-only commit and confirm the Stage 14 test fails because the model/enums do not exist.
- [ ] **Step 3:** Add `StorageBackend` and the Volume relation to Prisma schema.
- [ ] **Step 4:** Add SQL migration creating the enum/table, inserting the default backend, backfilling all existing Volumes, adding the non-null FK and indexes.
- [ ] **Step 5:** Run Prisma generate/build/test through CI and keep migration idempotency assumptions explicit.

### Task 2: Implement CephFS adapter primitives

**Files:**
- Create: `packages/resourceportal-api/src/storage-backends/storage-backend.logic.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-backend.logic.spec.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-command-runner.service.ts`
- Create: `packages/resourceportal-api/src/storage-backends/cephfs-storage-adapter.service.ts`
- Create: `packages/resourceportal-api/src/storage-backends/cephfs-storage-adapter.service.spec.ts`

**Interfaces:**
- Produces `CephFsStorageAdapterService.validateLocal()`, `provisionVolume()`, `resizeVolume()`, `deleteVolume()`, `measureUsedSize()` and `runtimeDriverOptions()`.

- [ ] **Step 1:** Test health mapping `HEALTH_OK/WARN/ERR`, `ceph df` byte parsing, safe logical-to-local path translation and NFS driver-option generation.
- [ ] **Step 2:** Confirm RED in CI because the logic module does not exist.
- [ ] **Step 3:** Implement the pure helpers and re-run focused tests.
- [ ] **Step 4:** Test adapter provisioning against a temporary filesystem with a fake command runner: directory creation, `setfattr`, `getfattr` verification and rollback on quota mismatch.
- [ ] **Step 5:** Implement command runner and adapter minimal behavior.
- [ ] **Step 6:** Test/implement grow-only quota update, safe deletion and recursive used-size measurement that ignores symlinks.
- [ ] **Step 7:** Test/implement Ceph health and capacity collection.

### Task 3: Backend service, platform API and reconciliation

**Files:**
- Create: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-backends.controller.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-backends.module.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-backend-reconciler.service.ts`
- Create: `packages/resourceportal-api/src/storage-backends/dto/set-storage-backend-maintenance.dto.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-backends.service.spec.ts`
- Modify: `packages/resourceportal-api/src/app.module.ts`

**Interfaces:**
- Produces `getDefaultBackend()`, `assertWritableCapacity(bytes)`, `provisionVolume()`, `resizeVolume()`, `deleteVolume()`, `measureUsedSize()`, `runtimeDriverOptions()`, `validateBackend()` and `setMaintenance()`.

- [ ] **Step 1:** Test rejection for Error/Unknown/Unhealthy, maintenance and insufficient capacity while allowing Healthy/Degraded Ready backends.
- [ ] **Step 2:** Confirm RED before implementing the service.
- [ ] **Step 3:** Implement backend lookup, live health/capacity refresh, capacity checks and persistence of telemetry.
- [ ] **Step 4:** Add platform-admin GET/list/validate/maintenance endpoints.
- [ ] **Step 5:** Add periodic reconciler using `STORAGE_BACKEND_RECONCILE_INTERVAL_MS`.

### Task 4: Validate NFS-Ganesha from required Swarm nodes

**Files:**
- Create: `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.ts`
- Create: `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`

**Interfaces:**
- Produces `validate(basePath): Promise<{ok:boolean; error?:string}>` using a temporary global Docker Swarm service.

- [ ] **Step 1:** Test construction of a global Swarm probe with an anonymous local-driver NFS volume and cleanup on success/failure.
- [ ] **Step 2:** Confirm RED before implementation.
- [ ] **Step 3:** Implement ready-node count, temporary service creation, task polling, timeout, failure diagnostics and unconditional service removal.
- [ ] **Step 4:** Include remote validation in `validateBackend`; when explicitly disabled, record local validation only without claiming remote validation success.

### Task 5: Move Volume lifecycle behind StorageBackend

**Files:**
- Modify: `packages/resourceportal-api/src/volumes/volumes.service.ts`
- Modify: `packages/resourceportal-api/src/volumes/volumes.module.ts`
- Modify: `packages/resourceportal-api/src/volumes/stage7-volume-lifecycle.spec.ts`
- Create: `packages/resourceportal-api/src/volumes/stage14-volume-backend.spec.ts`
- Retire/stop injecting: `packages/resourceportal-api/src/volumes/volume-storage.service.ts`

**Interfaces:**
- `VolumesService` consumes `StorageBackendsService` for physical operations.

- [ ] **Step 1:** Test create chooses default backend, checks quota/capacity, provisions CephFS quota before DB create and persists `storageBackendId`.
- [ ] **Step 2:** Test resize rejects shrink and performs backend quota growth before DB size change.
- [ ] **Step 3:** Test read delegates used-size measurement to the assigned backend.
- [ ] **Step 4:** Test delete preserves `VolumeInUse` and marks Error on physical cleanup failure.
- [ ] **Step 5:** Implement orchestration while preserving tenant quota locking.

### Task 6: Render NFS-backed Swarm volumes

**Files:**
- Modify: `packages/resourceportal-api/src/internal/deployment-worker.service.ts`
- Modify: `packages/resourceportal-api/src/internal/internal.module.ts`
- Modify/retire bind behavior: `packages/resourceportal-api/src/internal/stack-volume-provisioner.service.ts`
- Create: `packages/resourceportal-api/src/internal/stage14-stack-storage.spec.ts`

**Interfaces:**
- Stack snapshot carries `storageBackendId` and logical `storagePath`; top-level Compose volume definitions use `driver: local` and NFS `driver_opts`.

- [ ] **Step 1:** Add failing stack-render test proving an attached Volume is not external/bind-mounted and includes NFS options.
- [ ] **Step 2:** Expose backend runtime options to deployment preparation/rendering.
- [ ] **Step 3:** Stop creating host bind directories/Docker volumes in `StackVolumeProvisionerService` for CephFS volumes.
- [ ] **Step 4:** Keep stack apply/rollout behavior unchanged and run deployment tests.

### Task 7: Configuration, smoke coverage and documentation compliance

**Files:**
- Modify: `.env.example`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.spec.ts`
- Modify: `packages/resourceportal-api/package.json`
- Create: `packages/resourceportal-api/scripts/smoke-stage14-storage-backend.ts`
- Modify: `.github/workflows/swarm-integration.yml`
- Modify: `docs/wiki-compliance.md`

**Interfaces:**
- Production configuration validates NFS-Ganesha endpoint and positive storage reconciliation/probe timeouts.

- [ ] **Step 1:** Test invalid/missing production storage configuration.
- [ ] **Step 2:** Add env documentation and validation.
- [ ] **Step 3:** Add Stage 14 smoke command that validates platform API, lifecycle and rendered NFS stack behavior; live Ceph command execution is used when infrastructure variables are supplied.
- [ ] **Step 4:** Wire non-destructive Stage 14 smoke into real Swarm workflow with CI-safe command fakes where live Ceph is unavailable; keep live-infrastructure result distinct.
- [ ] **Step 5:** Update wiki-compliance evidence mapping.

### Task 8: Final verification and merge

**Files:** all Stage 14 changes.

- [ ] **Step 1:** Run/inspect dependency audit, Prisma generate, lint, full test and build on final head.
- [ ] **Step 2:** Run/inspect Real Docker Swarm Integration on final head.
- [ ] **Step 3:** Review PR diff against every Stage 14 checklist item and ensure no Stage 15/16 scope leaked in.
- [ ] **Step 4:** Merge only if required checks are green; otherwise leave PR open and report the exact blocker.
- [ ] **Step 5:** After verified merge, patch Wiki `Storage Backend` and `Implementation Stages` with implementation evidence, commit/PR/run identifiers and any live-Ceph verification caveat.