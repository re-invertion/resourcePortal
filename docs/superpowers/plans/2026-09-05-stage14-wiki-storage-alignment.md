# Stage 14 Wiki Storage Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the active ResourcePortal v1 storage implementation into exact alignment with the Wiki-approved LocalFilesystem architecture and close the storage-specific gaps in Stages 5, 6, 7 and 14.

**Architecture:** Use one `LocalFilesystem` StorageBackend backed by XFS or ext4 project quotas. Physical data lives under `/srv/resource-portal/storage/{volumes,secrets,platform}`, while Swarm services consume pre-mounted canonical runtime paths under `/mnt/resourceportal/*`; NFS-Ganesha is an access layer for remote nodes, not a Docker volume driver or StorageBackend type. Volume-backed services are constrained to nodes labeled `resourceportal.storage.volumes=true`, and tenant secrets continue to enter workloads only through Docker Swarm Secrets.

**Tech Stack:** TypeScript 5.9, NestJS 11, Prisma 6/PostgreSQL, Docker Swarm, XFS/ext4 project quotas, NFSv4/NFS-Ganesha, Vitest, GitHub Actions shell integration tests.

**Spec:** `docs/superpowers/specs/2026-09-05-stage14-wiki-storage-alignment-design.md`

## Global Constraints

- Wiki is the architectural source of truth; conflicting repository behavior must be changed to match it.
- `StorageBackendType.LocalFilesystem` is the only active v1 backend.
- Physical default root is `/srv/resource-portal/storage` with isolated `volumes`, `secrets`, and `platform` namespaces.
- Canonical runtime roots are `/mnt/resourceportal/volumes`, `/mnt/resourceportal/secrets`, and `/mnt/resourceportal/platform`.
- XFS is the default filesystem; ext4 remains supported.
- `Volume.sizeBytes` must be enforced as a verified project-quota hard limit.
- Workload Volume data must not be exposed by legacy Docker `local` NFS volumes pointing to `:/rp/...`.
- Volume-backed workloads require `node.labels.resourceportal.storage.volumes == true`.
- Tenant workloads must never receive the ResourcePortal `secrets` or `platform` namespace as a bind/NFS mount.
- Secret payloads remain envelope-encrypted at rest and are delivered to workloads as Docker Swarm Secrets.
- Single-node operation is mandatory and must not require a remote NFS round-trip for workload correctness.
- Storage mutation that changes project quotas remains privileged operation-worker work; the public API remains non-root.
- Historical CephFS migrations stay in migration history, but active code/config/tests must not present CephFS as a supported v1 runtime.

---

## File Structure

- `packages/resourceportal-api/src/storage-backends/storage-paths.ts` — one pure source of truth for physical and runtime namespace construction/validation.
- `packages/resourceportal-api/src/storage-backends/storage-paths.spec.ts` — path contract and traversal regression tests.
- `packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.ts` — local XFS/ext4 validation, quota lifecycle, capacity and physical path operations.
- `packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.spec.ts` — filesystem/quota unit tests.
- `packages/resourceportal-api/src/security/secret-storage.service.ts` — protected Secret payload path and encrypted atomic file lifecycle.
- `packages/resourceportal-api/src/security/secret-storage.service.spec.ts` — new Secret physical-path regressions.
- `packages/resourceportal-api/src/volumes/volume-storage.service.ts` — remove legacy Docker named-volume cleanup assumptions and keep path-safe local cleanup helpers only where still needed.
- `packages/resourceportal-api/src/volumes/volume-storage.service.spec.ts` — Volume cleanup/path safety regressions.
- `packages/resourceportal-api/src/internal/stack-storage.ts` — canonical bind-mount/runtime-volume rendering primitives.
- `packages/resourceportal-api/src/internal/stage14-stack-storage.spec.ts` — stack storage contract tests.
- `packages/resourceportal-api/src/internal/deployment-worker.service.ts` — mount Volume runtime paths and add storage placement constraints.
- `packages/resourceportal-api/src/internal/stack-volume-provisioner.service.ts` — replace legacy per-Docker-volume NFS provisioning with runtime-root readiness validation, or remove the service if all consumers can use a smaller readiness abstraction.
- `packages/resourceportal-api/src/internal/stack-volume-provisioner.service.spec.ts` — readiness validation tests rather than named NFS volume tests.
- `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.ts` — validate approved NFS namespace/runtime access without exposing secrets/platform to workload probes.
- `packages/resourceportal-api/src/config/env.validation.ts` and `.spec.ts` — validate explicit physical/runtime storage configuration.
- `packages/resourceportal-api/prisma/schema.prisma` plus a new migration — change active StorageBackend defaults from `/rp` to Wiki paths without rewriting historical migrations.
- `.env.example`, `packages/resourceportal-api/README.md`, `README.md` — active configuration/documentation defaults.
- `.github/workflows/swarm-integration.yml` and `scripts/run-real-swarm-smoke.sh` — real XFS/NFS-Ganesha/canonical-runtime smoke.

---

### Task 1: Centralize the Wiki-approved storage path contract

**Files:**
- Create: `packages/resourceportal-api/src/storage-backends/storage-paths.ts`
- Create: `packages/resourceportal-api/src/storage-backends/storage-paths.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backend.logic.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backend.logic.spec.ts`

**Interfaces:**
- Produces: `DEFAULT_STORAGE_BASE_PATH`, `DEFAULT_VOLUME_RUNTIME_ROOT`, `DEFAULT_SECRET_RUNTIME_ROOT`, `DEFAULT_PLATFORM_RUNTIME_ROOT`.
- Produces: `physicalVolumePath(basePath, tenantId, volumeId): string`.
- Produces: `physicalSecretPath(basePath, tenantId, appGroupId, secretName): string`.
- Produces: `volumeRuntimePath(runtimeRoot, tenantId, volumeId): string`.
- Produces: `assertPathWithin(root, candidate): string` returning normalized safe path or throwing.
- Later tasks consume these functions instead of embedding `/rp`, `/srv/...`, or `/mnt/...` literals.

- [ ] **Step 1: Write failing path contract tests**

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_RUNTIME_ROOT,
  DEFAULT_SECRET_RUNTIME_ROOT,
  DEFAULT_STORAGE_BASE_PATH,
  DEFAULT_VOLUME_RUNTIME_ROOT,
  physicalSecretPath,
  physicalVolumePath,
  volumeRuntimePath,
} from "./storage-paths";

describe("Wiki storage paths", () => {
  it("uses the approved defaults", () => {
    expect(DEFAULT_STORAGE_BASE_PATH).toBe("/srv/resource-portal/storage");
    expect(DEFAULT_VOLUME_RUNTIME_ROOT).toBe("/mnt/resourceportal/volumes");
    expect(DEFAULT_SECRET_RUNTIME_ROOT).toBe("/mnt/resourceportal/secrets");
    expect(DEFAULT_PLATFORM_RUNTIME_ROOT).toBe("/mnt/resourceportal/platform");
  });

  it("builds physical and runtime Volume paths", () => {
    expect(physicalVolumePath(DEFAULT_STORAGE_BASE_PATH, "tenant-a", "volume-a"))
      .toBe("/srv/resource-portal/storage/volumes/tenant-a/volume-a");
    expect(volumeRuntimePath(DEFAULT_VOLUME_RUNTIME_ROOT, "tenant-a", "volume-a"))
      .toBe("/mnt/resourceportal/volumes/tenant-a/volume-a");
  });

  it("builds protected Secret paths", () => {
    expect(physicalSecretPath(DEFAULT_STORAGE_BASE_PATH, "tenant-a", "app-a", "api-key"))
      .toBe("/srv/resource-portal/storage/secrets/tenant-a/app-a/api-key");
  });

  it("rejects traversal", () => {
    expect(() => physicalVolumePath(DEFAULT_STORAGE_BASE_PATH, "../outside", "volume-a"))
      .toThrow("Storage path segment is invalid");
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npm --workspace @resource-portal/api exec vitest run src/storage-backends/storage-paths.spec.ts
```

Expected: FAIL because `storage-paths.ts` does not exist.

- [ ] **Step 3: Implement the pure path module**

Use `node:path.posix`, reject empty, `.`, `..`, slash-containing and traversal-capable identifiers, normalize every result, and verify it stays below its root. Keep the module independent of NestJS/ConfigService so all storage subsystems can reuse it.

- [ ] **Step 4: Remove `buildNfsDriverOptions` from the active stack-path contract**

`storage-backend.logic.ts` should retain only helpers that are still valid for LocalFilesystem physical/runtime mapping. Delete active code paths whose only purpose is generating `type=nfs`, `device=:/rp/...` Docker volume driver definitions. Preserve no compatibility shim in the active renderer.

- [ ] **Step 5: Run path tests**

Run:

```bash
npm --workspace @resource-portal/api exec vitest run src/storage-backends/storage-paths.spec.ts src/storage-backends/storage-backend.logic.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/resourceportal-api/src/storage-backends/storage-paths.ts \
  packages/resourceportal-api/src/storage-backends/storage-paths.spec.ts \
  packages/resourceportal-api/src/storage-backends/storage-backend.logic.ts \
  packages/resourceportal-api/src/storage-backends/storage-backend.logic.spec.ts
git commit -m "refactor(stage14): centralize wiki storage paths"
```

---

### Task 2: Align StorageBackend metadata and LocalFilesystem defaults

**Files:**
- Create: `packages/resourceportal-api/prisma/migrations/20260905_stage14_wiki_storage_paths/migration.sql`
- Modify: `packages/resourceportal-api/prisma/schema.prisma:589-608`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backend.store.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backend.prisma.spec.ts`
- Modify: `.env.example`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.spec.ts`

**Interfaces:**
- Consumes path defaults from Task 1.
- Produces persisted default backend metadata with physical paths under `/srv/resource-portal/storage`.
- Produces explicit runtime-root env contract: `RESOURCE_VOLUME_RUNTIME_ROOT`, `RESOURCE_SECRET_RUNTIME_ROOT`, `RESOURCE_PLATFORM_RUNTIME_ROOT`.

- [ ] **Step 1: Write failing metadata/default tests**

Add assertions that Prisma defaults and the seeded/default backend expose:

```ts
expect(backend.basePath).toBe("/srv/resource-portal/storage");
expect(backend.volumeBasePath).toBe("/srv/resource-portal/storage/volumes");
expect(backend.secretBasePath).toBe("/srv/resource-portal/storage/secrets");
```

Add environment-validation coverage that production accepts the canonical runtime roots and rejects relative runtime roots.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/storage-backends/storage-backend.prisma.spec.ts \
  src/config/env.validation.spec.ts
```

Expected: FAIL on old `/rp` defaults and missing runtime-root validation.

- [ ] **Step 3: Add a forward-only Prisma migration**

The migration must update active defaults and the singleton backend metadata without editing `20260831102000_stage14_storage_backend/migration.sql` or other historical migrations:

```sql
ALTER TABLE "StorageBackend"
  ALTER COLUMN "basePath" SET DEFAULT '/srv/resource-portal/storage',
  ALTER COLUMN "volumeBasePath" SET DEFAULT '/srv/resource-portal/storage/volumes',
  ALTER COLUMN "secretBasePath" SET DEFAULT '/srv/resource-portal/storage/secrets';

UPDATE "StorageBackend"
SET
  "basePath" = '/srv/resource-portal/storage',
  "volumeBasePath" = '/srv/resource-portal/storage/volumes',
  "secretBasePath" = '/srv/resource-portal/storage/secrets',
  "status" = 'Error',
  "health" = 'Unknown',
  "lastValidationError" = 'Storage backend requires Wiki-path validation after migration',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-4000-8000-000000000014'::uuid;
```

- [ ] **Step 4: Update schema/default configuration**

Set Prisma defaults to the same physical paths. In `.env.example`, replace active `/rp` defaults with:

```dotenv
RESOURCE_STORAGE_BASE_PATH=/srv/resource-portal/storage
RESOURCE_VOLUME_RUNTIME_ROOT=/mnt/resourceportal/volumes
RESOURCE_SECRET_RUNTIME_ROOT=/mnt/resourceportal/secrets
RESOURCE_PLATFORM_RUNTIME_ROOT=/mnt/resourceportal/platform
```

Retain command overrides for `findmnt`, `xfs_quota`, `setquota`, `chattr`, and `lsattr`. Remove active `RESOURCE_STORAGE_ROOT=/rp/volumes` and `RESOURCE_SECRET_STORAGE_ROOT=/rp/secrets` defaults.

- [ ] **Step 5: Validate absolute storage roots in `env.validation.ts`**

Add a helper such as:

```ts
function requireAbsolutePathIfSet(config: Env, errors: string[], key: string) {
  const value = config[key];
  if (value && !value.startsWith("/")) errors.push(`${key} must be an absolute path`);
}
```

Apply it to the physical and three runtime root variables.

- [ ] **Step 6: Generate Prisma client and rerun focused tests**

```bash
npm --workspace @resource-portal/api run prisma:generate
npm --workspace @resource-portal/api exec vitest run \
  src/storage-backends/storage-backend.prisma.spec.ts \
  src/config/env.validation.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/resourceportal-api/prisma packages/resourceportal-api/src/config \
  packages/resourceportal-api/src/storage-backends/storage-backend.store.ts \
  packages/resourceportal-api/src/storage-backends/storage-backend.prisma.spec.ts \
  .env.example
git commit -m "feat(stage14): adopt wiki storage metadata paths"
```

---

### Task 3: Make LocalFilesystem quota lifecycle use physical Wiki paths and verify hard limits

**Files:**
- Modify: `packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`
- Modify: `packages/resourceportal-api/src/volumes/stage14-volume-backend.spec.ts`

**Interfaces:**
- Consumes `physicalVolumePath()` from Task 1 and persisted backend metadata from Task 2.
- Produces `provisionVolume()` and `resizeVolume()` that verify both project assignment and effective hard quota before success.
- Produces `runtimeVolumePath(tenantId, volumeId)` through StorageBackendsService or the shared path module; it no longer returns Docker NFS driver options.

- [ ] **Step 1: Add failing tests for physical mapping and quota readback**

Extend adapter tests to assert:

```ts
expect(await adapter.provisionVolume(backend, input)).toEqual({
  storagePath: "/srv/resource-portal/storage/volumes/tenant-a/volume-a",
});
```

Mock quota commands so a quota readback mismatch causes:

```ts
await expect(adapter.provisionVolume(backend, input))
  .rejects.toThrow("Storage project quota verification failed");
```

Cover XFS and ext4 separately.

- [ ] **Step 2: Run focused adapter tests and verify RED**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/storage-backends/local-filesystem-storage-adapter.service.spec.ts \
  src/volumes/stage14-volume-backend.spec.ts
```

Expected: FAIL on old mount/path semantics or missing quota-limit readback.

- [ ] **Step 3: Refactor physical path resolution**

Do not derive local paths by stripping a logical `/rp` prefix. Resolve the configured `basePath` directly as the physical namespace. `STORAGE_MOUNT_ROOT=/mnt/resourceportal-storage` must cease to be the active default abstraction.

- [ ] **Step 4: Verify hard quota after create/resize**

For XFS, query project quota state with `xfs_quota` after applying the limit. For ext4, query project quota state with an available quota command suitable for project IDs. Parse the effective hard limit and require it to equal the requested `sizeBytes` within the command's block-size representation; if the tool reports KiB blocks, compare against the rounded-up block count used to set the limit.

Keep project-ID verification through `lsattr -pd`.

- [ ] **Step 5: Keep failure rollback consistent**

Create failure removes only a newly created Volume directory. Resize failure must not finalize `Volume.sizeBytes`; existing `pendingSizeBytes`/`failResize()` flow remains authoritative.

- [ ] **Step 6: Remove `runtimeDriverOptions()` from LocalFilesystem adapter**

The adapter is physical-storage logic. Runtime path construction belongs to the shared path/runtime layer and deployment renderer.

- [ ] **Step 7: Run focused tests**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/storage-backends/local-filesystem-storage-adapter.service.spec.ts \
  src/storage-backends/storage-backend.logic.spec.ts \
  src/volumes/stage14-volume-backend.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/resourceportal-api/src/storage-backends packages/resourceportal-api/src/volumes/stage14-volume-backend.spec.ts
git commit -m "feat(stage14): verify local filesystem project quotas"
```

---

### Task 4: Move Secret storage into the protected physical namespace

**Files:**
- Modify: `packages/resourceportal-api/src/security/secret-storage.service.ts:32-45`
- Modify: `packages/resourceportal-api/src/security/secret-storage.service.spec.ts`
- Modify: `scripts/backup-control-plane.sh`
- Modify: `scripts/restore-control-plane.sh`
- Modify: `packages/resourceportal-api/README.md`

**Interfaces:**
- Consumes `physicalSecretPath()` and `DEFAULT_STORAGE_BASE_PATH` from Task 1.
- SecretStorageService still exposes `path()`, `read()`, `replaceAtomically()`, `deleteAtomically()`, and `deleteBestEffort()` with unchanged encryption semantics.

- [ ] **Step 1: Add a failing default-path test**

```ts
it("uses the protected Wiki Secret namespace by default", () => {
  const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
  const storage = new SecretStorageService(config, new EncryptionService(config));
  expect(storage.path("tenant-a", "app-a", "api-key")).toBe(
    "/srv/resource-portal/storage/secrets/tenant-a/app-a/api-key",
  );
});
```

Keep all existing encryption/rollback tests.

- [ ] **Step 2: Run the Secret tests and verify RED**

```bash
npm --workspace @resource-portal/api exec vitest run src/security/secret-storage.service.spec.ts
```

Expected: FAIL because the fallback is `/rp/secrets`.

- [ ] **Step 3: Implement path generation from physical basePath**

Use `RESOURCE_STORAGE_BASE_PATH` and `physicalSecretPath()`. Do not add a second independent Secret-root source of truth.

- [ ] **Step 4: Align backup/restore utilities**

Change their default encrypted Secret artifact root to `${RESOURCE_STORAGE_BASE_PATH:-/srv/resource-portal/storage}/secrets`. Preserve the Stage 19 property that backup handles encrypted payloads without exposing plaintext.

- [ ] **Step 5: Rerun Secret tests**

```bash
npm --workspace @resource-portal/api exec vitest run src/security/secret-storage.service.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/resourceportal-api/src/security scripts/backup-control-plane.sh \
  scripts/restore-control-plane.sh packages/resourceportal-api/README.md
git commit -m "feat(stage5): move secret storage to protected namespace"
```

---

### Task 5: Remove legacy Docker named-volume/NFS provisioning from Volume lifecycle

**Files:**
- Modify: `packages/resourceportal-api/src/volumes/volume-storage.service.ts`
- Modify: `packages/resourceportal-api/src/volumes/volume-storage.service.spec.ts`
- Modify: `packages/resourceportal-api/src/volumes/stage7-volume-lifecycle.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`

**Interfaces:**
- Physical create/resize/delete remains owned by StorageBackendsService/LocalFilesystem adapter.
- `dockerVolumeName` may remain as historical persisted metadata until a dedicated cleanup migration is justified, but active delete/runtime correctness must not depend on a Docker named volume existing.

- [ ] **Step 1: Rewrite failing VolumeStorageService expectations**

Replace tests that expect `docker volume inspect/rm` with tests asserting physical path safety and cleanup delegation. For example:

```ts
expect(() => service.assertSafeStoragePathForTest({
  tenantId: "tenant-a",
  volumeId: "volume-a",
  storagePath: "/tmp/outside",
})).toThrow("Unsafe volume storage path");
```

If the private helper cannot be tested without distorting the public API, move path validation into the Task 1 pure helper and test it there instead; keep `VolumeStorageService` small.

- [ ] **Step 2: Run focused Volume lifecycle tests and verify RED**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/volumes/volume-storage.service.spec.ts \
  src/volumes/stage7-volume-lifecycle.spec.ts
```

- [ ] **Step 3: Delete active Docker named-volume cleanup**

Remove `docker volume inspect` / `docker volume rm` from the physical Volume lifecycle. Deletion should use the backend adapter after domain-level `VolumeInUse` checks have passed.

- [ ] **Step 4: Remove obsolete `/rp/volumes` fallback logic**

All physical safety checks must derive from StorageBackend base path / Task 1 helpers.

- [ ] **Step 5: Run focused tests**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/volumes/volume-storage.service.spec.ts \
  src/volumes/stage7-volume-lifecycle.spec.ts \
  src/volumes/stage14-volume-backend.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/resourceportal-api/src/volumes packages/resourceportal-api/src/storage-backends/storage-backends.service.ts
git commit -m "refactor(stage7): remove legacy docker volume lifecycle"
```

---

### Task 6: Render canonical bind mounts and storage placement constraints in Swarm stacks

**Files:**
- Modify: `packages/resourceportal-api/src/internal/stack-storage.ts`
- Modify: `packages/resourceportal-api/src/internal/stage14-stack-storage.spec.ts`
- Modify: `packages/resourceportal-api/src/internal/deployment-worker.service.ts:1425-1540`
- Test: existing deployment renderer specs plus new Stage 14 assertions.

**Interfaces:**
- Produces service mount strings using `/mnt/resourceportal/volumes/{tenantId}/{volumeId}` as source.
- Produces `deploy.placement.constraints` containing `node.labels.resourceportal.storage.volumes == true` only for services that attach tenant Volumes.
- Top-level legacy Docker volume definitions for tenant storage disappear from the rendered stack.

- [ ] **Step 1: Replace Stage 14 renderer tests with the approved contract**

```ts
it("renders a canonical bind source for an attached Volume", () => {
  expect(renderRuntimeVolumeMount({
    tenantId: "tenant-a",
    volumeId: "volume-a",
    mountPath: "/data",
    mode: "ReadWrite",
  })).toBe("/mnt/resourceportal/volumes/tenant-a/volume-a:/data:rw");
});

it("requires the storage readiness label when a service uses a Volume", () => {
  expect(storagePlacementConstraints([{ volumeId: "volume-a" }]))
    .toContain("node.labels.resourceportal.storage.volumes == true");
});
```

- [ ] **Step 2: Run Stage 14 renderer tests and verify RED**

```bash
npm --workspace @resource-portal/api exec vitest run src/internal/stage14-stack-storage.spec.ts
```

- [ ] **Step 3: Change stack-storage helpers**

Replace `renderStackStorageVolumes()` with focused helpers such as:

```ts
export function renderRuntimeVolumeMount(input: {
  runtimeRoot: string;
  tenantId: string;
  volumeId: string;
  mountPath: string;
  mode: "ReadOnly" | "ReadWrite";
}): string;

export function storagePlacementConstraints(hasVolumes: boolean): string[];
```

Use `volumeRuntimePath()` from Task 1.

- [ ] **Step 4: Ensure deployment snapshots carry stable tenantId/volumeId**

If the current `StackConfigSnapshot` Volume entry only contains `storagePath` and display names, extend snapshot construction in `app-groups.service.ts` so each attachment has the identifiers required to derive the runtime path without parsing a stored path. Persisted `storagePath` remains physical metadata, not a runtime source.

- [ ] **Step 5: Render bind mounts and placement in `renderService()`**

For a service with Volumes:

```ts
volumes: singleApp.volumes.map((volume) =>
  renderRuntimeVolumeMount({
    runtimeRoot,
    tenantId: snapshot.tenantId,
    volumeId: volume.volumeId,
    mountPath: volume.mountPath,
    mode: volume.mode,
  }),
),
deploy: {
  ...,
  placement: { constraints: storagePlacementConstraints(singleApp.volumes.length > 0) },
}
```

Merge with any future/existing placement object rather than overwriting unrelated constraints.

- [ ] **Step 6: Remove active top-level tenant Volume definitions**

`renderVolumes(snapshot)` should no longer generate NFS `driver_opts` for tenant Volumes. If no other subsystem needs top-level stack volumes, remove this field entirely for tenant storage.

- [ ] **Step 7: Run renderer/deployment tests**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/internal/stage14-stack-storage.spec.ts \
  src/internal/deployment-worker.service.spec.ts
```

Expected: PASS with no `:/rp/volumes` or `driver_opts.type=nfs` in rendered tenant Volume stack YAML.

- [ ] **Step 8: Commit**

```bash
git add packages/resourceportal-api/src/internal packages/resourceportal-api/src/app-groups
git commit -m "feat(stage6): mount volumes from canonical runtime paths"
```

---

### Task 7: Replace per-volume NFS probes with namespace readiness and label validation

**Files:**
- Modify or replace: `packages/resourceportal-api/src/internal/stack-volume-provisioner.service.ts`
- Modify: `packages/resourceportal-api/src/internal/stack-volume-provisioner.service.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service.spec.ts`
- Modify: `packages/resourceportal-api/src/storage-backends/storage-backends.service.ts`

**Interfaces:**
- Produces a validation result proving the approved `volumes` namespace is reachable on nodes intended to receive `resourceportal.storage.volumes=true`.
- Does not create one Docker named NFS volume per tenant Volume.
- Must never probe or expose `/mnt/resourceportal/secrets` or `/mnt/resourceportal/platform` from a workload-mode validation service.

- [ ] **Step 1: Write RED tests for node eligibility**

Test that node inspection includes labels and readiness:

```ts
const node = "node-a|Ready|true";
expect(parseStorageNode(node)).toEqual({ id: "node-a", ready: true, volumesReady: true });
```

Test that a node with the label missing/false is not counted as eligible.

- [ ] **Step 2: Write a RED test for the probe mount**

The probe service must bind the canonical runtime root rather than create an NFS Docker volume:

```ts
expect(createArgs).toContain("type=bind,source=/mnt/resourceportal/volumes,target=/probe");
expect(createArgs.join(" ")).not.toContain("volume-driver=local");
expect(createArgs.join(" ")).not.toContain(":/rp/");
```

- [ ] **Step 3: Implement namespace readiness validation**

List Swarm nodes with status and `resourceportal.storage.volumes` label. Validate only eligible Ready nodes. A validation failure makes storage readiness fail closed when remote validation is required.

- [ ] **Step 4: Keep NFS-Ganesha as infrastructure configuration only**

`NFS_GANESHA_SERVER` remains relevant to installer/host mount setup and any explicit NFS endpoint health validation, but application stack rendering no longer consumes it to create tenant Docker volumes.

- [ ] **Step 5: Remove stale CephFS wording**

Change messages/tests such as `NFS_GANESHA_SERVER is required for CephFS Volume provisioning` and `validates the CephFS export` to LocalFilesystem/NFS namespace language.

- [ ] **Step 6: Run readiness tests**

```bash
npm --workspace @resource-portal/api exec vitest run \
  src/internal/stack-volume-provisioner.service.spec.ts \
  src/storage-backends/nfs-remote-access-validator.service.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/resourceportal-api/src/internal/stack-volume-provisioner.service* \
  packages/resourceportal-api/src/storage-backends/nfs-remote-access-validator.service* \
  packages/resourceportal-api/src/storage-backends/storage-backends.service.ts
git commit -m "refactor(stage14): validate canonical storage readiness"
```

---

### Task 8: Rebuild the real XFS/NFS-Ganesha/Swarm smoke around canonical mounts

**Files:**
- Modify: `.github/workflows/swarm-integration.yml`
- Modify: `scripts/run-real-swarm-smoke.sh`
- Modify: `packages/resourceportal-api/scripts/smoke-stage14-storage-backend.ts`
- Modify: `packages/resourceportal-api/scripts/smoke-volume-lifecycle.ts`
- Modify: `packages/resourceportal-api/scripts/smoke-deploy.ts`
- Modify: `packages/resourceportal-api/scripts/smoke-stage16-operations.ts`

**Interfaces:**
- CI creates/uses real XFS project quota storage and canonical physical/runtime roots.
- Single-node node gets `resourceportal.storage.volumes=true` only after mount/readiness verification.
- Real deployed service proves a tenant Volume is readable/writable through `/mnt/resourceportal/volumes/...`.

- [ ] **Step 1: Make smoke assertions fail on legacy paths**

Add preflight assertions:

```bash
! grep -R "/rp/volumes" packages/resourceportal-api/src .env.example
! grep -R "device=:/rp" packages/resourceportal-api/src
```

Exclude historical migration SQL from this active-runtime grep.

- [ ] **Step 2: Prepare real physical layout in the workflow**

After mounting the loop-backed XFS filesystem with project quotas, create:

```bash
mkdir -p /srv/resource-portal/storage/{volumes,secrets,platform}
mkdir -p /mnt/resourceportal/{volumes,secrets,platform}
mount --bind /srv/resource-portal/storage/volumes /mnt/resourceportal/volumes
mount --bind /srv/resource-portal/storage/secrets /mnt/resourceportal/secrets
mount --bind /srv/resource-portal/storage/platform /mnt/resourceportal/platform
```

For CI, only set a storage readiness label after `findmnt`/write probes succeed.

- [ ] **Step 3: Configure NFS-Ganesha export isolation**

The workload-facing export must expose `volumes` only. Add a CI assertion proving a workload-mode probe cannot address the protected `secrets` or `platform` namespace through that export.

- [ ] **Step 4: Update Stage 14 backend smoke expectations**

Expect:

```ts
expectField(backend, "basePath", "/srv/resource-portal/storage");
expectField(backend, "volumeBasePath", "/srv/resource-portal/storage/volumes");
expectField(backend, "secretBasePath", "/srv/resource-portal/storage/secrets");
```

- [ ] **Step 5: Add a real quota enforcement assertion**

Create a small Volume with a hard quota, write data up to the limit, then verify an additional write fails with quota enforcement rather than merely checking metadata.

- [ ] **Step 6: Add a real Volume-backed Swarm workload assertion**

Deploy a service whose rendered mount source is `/mnt/resourceportal/volumes/{tenantId}/{volumeId}` and verify its task is scheduled on a node carrying `resourceportal.storage.volumes=true` and can persist/read a marker.

- [ ] **Step 7: Verify cleanup**

Always remove temporary services/stacks, labels created solely by CI, bind mounts, loop mounts and test files. Keep the existing check for leaked `rp_*` stacks/services.

- [ ] **Step 8: Run the reusable smoke locally where Docker privileges are available**

```bash
bash scripts/run-real-swarm-smoke.sh
```

Expected: Stage 14 storage, Volume lifecycle, deployment smoke and cleanup all pass. If the current MCP workspace lacks privileged Docker/mount capabilities, record that limitation and rely on the same committed runner in GitHub Actions; do not fake the success locally.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/swarm-integration.yml scripts/run-real-swarm-smoke.sh \
  packages/resourceportal-api/scripts
git commit -m "test(stage14): verify canonical storage runtime"
```

---

### Task 9: Run full regression, purge active legacy paths, and update implementation evidence

**Files:**
- Modify: `README.md`
- Modify: `packages/resourceportal-api/README.md`
- Modify: `docs/superpowers/specs/2026-08-31-stage14-storage-backend-design.md` to mark it historical/superseded rather than authoritative where it conflicts.
- Modify only after verification: Wiki `Implementation Stages`, `Storage Backend`, `Volume`, `Secret`, and `Deployment Engine` documents.

**Interfaces:**
- Produces a repository where active runtime/config/docs agree with the approved spec.
- Produces exact verification evidence for Stage 5/6/7/14 status updates.

- [ ] **Step 1: Search for prohibited active legacy references**

Run:

```bash
grep -RIn "/rp/volumes\|/rp/secrets\|/mnt/resourceportal-storage\|CephFS Volume provisioning" \
  .env.example README.md packages scripts .github \
  --exclude-dir=node_modules \
  --exclude='migration.sql'
```

Expected: no active runtime/config references. Any remaining match must be explicitly historical text or a migration compatibility test; otherwise fix it before continuing.

- [ ] **Step 2: Run Prisma generation**

```bash
npm --workspace @resource-portal/api run prisma:generate
```

Expected: PASS.

- [ ] **Step 3: Run API unit/integration suite**

```bash
npm --workspace @resource-portal/api test
```

Expected: PASS.

- [ ] **Step 4: Run repository lint**

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Run repository build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 6: Run repository test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Run the real Swarm/storage integration runner**

```bash
bash scripts/run-real-swarm-smoke.sh
```

Expected: PASS in a privileged Docker-capable environment. If unavailable locally, require the corresponding GitHub Actions Real Docker Swarm Integration result for the exact final commit before marking Stage 14 complete.

- [ ] **Step 8: Update repository documentation**

State clearly that the 2026-09-05 Wiki-alignment spec supersedes conflicting active-runtime details in the older Stage 14 design. Historical CephFS migration facts remain documented as history only.

- [ ] **Step 9: Commit repository documentation**

```bash
git add README.md packages/resourceportal-api/README.md docs/superpowers/specs/2026-08-31-stage14-storage-backend-design.md
git commit -m "docs(stage14): document canonical local storage runtime"
```

- [ ] **Step 10: Push branch / create PR and collect exact-head verification**

The final implementation evidence must name the exact head SHA and results for CI, Real Docker Swarm Integration and Live Federation Integration. Do not mark Wiki steps complete based only on local tests.

- [ ] **Step 11: Re-audit Stage 5, 6, 7 and 14 against Wiki**

Expected likely outcomes if all requirements above pass:

```text
5.11 Secret storagePath        -> ✅
6.27 Volume runtime integration -> ✅
7.8-7.10 physical namespace/quota -> ✅
7.18 physical cleanup          -> ✅
14.2-14.18 applicable v1 items -> ✅ except explicitly N/D/future-only items
```

Only assign ✅ when exact implementation and required verification exist.

- [ ] **Step 12: Patch Wiki with verified evidence**

Use Wiki patch updates rather than whole-document replacement. Update `Implementation Stages` plus related Storage Backend / Volume / Secret / Deployment Engine pages. Include final commit/PR/workflow evidence and keep Stage 24 as Design Complete unless its installer implementation has separately started.

---

## Self-review results

- **Spec coverage:** physical/runtime namespaces, XFS/ext4 quota, Secrets, platform isolation contract, NFS-Ganesha boundary, Swarm readiness labels, single-node behavior, multi-node readiness semantics, Deployment Engine change, failure handling, migration compatibility and required tests are all mapped to tasks.
- **Intentional Stage 24 boundary:** host installation of NFS-Ganesha, persistent `/etc/fstab` management, enrollment token flow, PostgreSQL failover/fencing and installer repair UI remain outside this plan.
- **Type consistency:** path helpers defined in Task 1 are the only new cross-task path API; later tasks consume those exact names.
- **No placeholder work:** every implementation task has a concrete RED test, implementation target, verification command and commit boundary.
