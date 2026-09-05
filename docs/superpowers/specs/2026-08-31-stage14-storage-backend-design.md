# Stage 14 — StorageBackend / LocalFilesystem Design

> **SUPERSEDED / HISTORICAL (2026-09-05).** This document records the earlier LocalFilesystem transition design and is not authoritative for active runtime paths. The ResourcePortal Wiki is the architectural source of truth. The approved replacement design is `docs/superpowers/specs/2026-09-05-stage14-wiki-storage-alignment-design.md`, which requires physical storage under `/srv/resource-portal/storage`, canonical runtime mounts under `/mnt/resourceportal/*`, storage-readiness node labels, and no per-Volume Docker NFS driver path. Historical migration details below are retained for audit only.

## Status

This document is historical and has been superseded by the 2026-09-05 Wiki-alignment design.

CephFS is **not** a v1 backend. It may be introduced later as a separate backend without changing the tenant-facing Volume API.

## Goal

ResourcePortal owns persistent-storage metadata, tenant quota policy, Volume lifecycle and physical per-Volume quota enforcement.

The v1 backend is host-managed local storage:

- XFS is the preferred filesystem,
- ext4 is supported,
- project quotas are mandatory,
- the storage filesystem is mounted on the storage host,
- NFS-Ganesha exports the logical ResourcePortal namespace to Docker Swarm workers.

This architecture must work on a single ResourcePortal node. Additional Swarm nodes may consume the same Volume data through NFS-Ganesha; they do not need the storage filesystem mounted locally.

ResourcePortal does not create or manage software RAID. If the host exposes storage through hardware RAID, LVM or another host-managed block layout, ResourcePortal consumes the resulting mounted filesystem.

## Namespace

The platform namespace remains rooted at `/rp`:

- `/rp/volumes/{tenantId}/{volumeId}` — persistent Volume data,
- `/rp/secrets/{tenantId}/{appGroupId}/{secretName}` — reserved filesystem-backed secret namespace.

The default StorageBackend uses:

- `basePath=/rp`,
- `volumeBasePath=/rp/volumes`,
- `secretBasePath=/rp/secrets`.

`Volume.storagePath` stores the logical `/rp/...` path. The local adapter maps that path below `STORAGE_MOUNT_ROOT`.

Example:

- logical path: `/rp/volumes/tenant-a/volume-a`,
- `STORAGE_MOUNT_ROOT=/mnt/resourceportal-storage`,
- physical path: `/mnt/resourceportal-storage/volumes/tenant-a/volume-a`.

The backend base path is stripped during local mapping. A logical path escaping `basePath` is rejected.

## Data model

`StorageBackend` is platform-owned and has:

- `id: uuid`,
- `name: string`,
- `type: LocalFilesystem`,
- `basePath`,
- `volumeBasePath`,
- `secretBasePath`,
- `status: Ready | Error`,
- `health: Healthy | Degraded | Unhealthy | Unknown`,
- `maintenance: boolean`,
- `capacityTotal: bytes | null`,
- `capacityAvailable: bytes | null`,
- `lastValidatedAt: datetime | null`,
- `lastValidationError: string | null`.

The default backend keeps the stable platform backend UUID and is named `default-local-filesystem`.

`Volume` has:

- required `storageBackendId`,
- required logical `storagePath`,
- required unique `storageProjectId`,
- requested `sizeBytes`,
- optional `pendingSizeBytes`,
- optional measured `usedSizeBytes`.

`storageProjectId` is a durable Linux project-quota identifier allocated from a PostgreSQL sequence. IDs are not derived by hashing UUIDs and are not intentionally reused.

## LocalFilesystem adapter

The adapter owns physical storage behavior.

### Validation

Validation:

1. resolves `STORAGE_MOUNT_ROOT`,
2. inspects the filesystem with `findmnt`,
3. accepts only XFS or ext4,
4. requires `prjquota` or `pquota`,
5. reads total and available capacity from local `statfs`,
6. reports `Healthy` when the local validation succeeds.

NFS-Ganesha remote validation remains a separate check. The backend is `Ready` only when required local and remote checks succeed.

### Project quota contract

Each Volume directory receives its own numeric project ID.

Quota enforcement is filesystem-specific:

- **XFS** — ResourcePortal uses `xfs_quota` in expert mode to assign the project and apply equal hard/soft byte limits.
- **ext4** — ResourcePortal assigns the directory project ID and project hierarchy flag with `chattr`, then applies project limits with `setquota -P`. ext4 block limits are expressed in KiB, so requested byte limits are rounded up to the next KiB.

After provisioning ResourcePortal reads the directory project ID back with `lsattr -pd`. A mismatch is treated as provisioning failure and the newly-created directory is removed.

Volume shrink remains unsupported.

### Privilege boundary

Quota mutation is intentionally separated from normal API execution.

- the ResourcePortal runtime image defaults to the non-root `node` user,
- API and normal non-storage processes remain non-root,
- only the `operation-worker` instance responsible for Volume mutation is started as root on the designated storage node,
- that worker receives the local storage mount read-write and only the runtime privileges/capabilities required by the supported quota tools,
- the API remains non-root and receives only read-only access to the local storage mount on the storage/control-plane node so it can perform backend validation and `usedSizeBytes` measurement,
- the adapter refuses provisioning and quota resize when the process effective UID is not `0`.

This prevents accidentally moving privileged quota operations back into the public API process. Read-only validation, capacity inspection, used-size measurement and NFS driver-option generation do not require the privileged mutation path.

In the initial one-storage-node deployment, API and operation-worker are constrained to the storage/control-plane node because their local filesystem operations target `STORAGE_MOUNT_ROOT`. Workload tasks on other Swarm nodes use NFS-Ganesha instead of the local mount. A future control-plane HA design must explicitly replace this local read dependency before allowing API placement away from the storage node.

### Used size

Used bytes are measured recursively from the local Volume directory without following symbolic links. This value is operational telemetry; the project quota remains the physical enforcement mechanism.

## Volume lifecycle

### Create

1. refresh/check the default backend,
2. lock tenant quota,
3. validate tenant quota,
4. lock backend capacity,
5. validate committed and physically available capacity,
6. allocate a unique `storageProjectId`,
7. persist the Volume in `Creating` state with backend ID, project ID and logical storage path,
8. outside the database transaction create the local directory,
9. assign the project ID,
10. apply and verify the physical quota,
11. move the Volume to `Ready`.

Physical provisioning is intentionally outside the database transaction and executes through the privileged operation-worker.

If physical provisioning fails, ResourcePortal removes the newly-created directory and removes the database record when cleanup succeeds. A cleanup failure leaves the Volume in `Error` for operator recovery.

### Resize

1. reject shrink,
2. refresh/check the Volume backend,
3. lock tenant quota,
4. validate tenant quota,
5. lock backend capacity,
6. reserve the requested size in `pendingSizeBytes`,
7. read the existing durable project ID,
8. verify the directory still has that project ID,
9. grow the project quota through the privileged operation-worker,
10. commit the new `sizeBytes` and return the Volume to `Ready`.

### Delete

The existing `VolumeInUse` guard remains mandatory. Physical directory removal happens before database deletion. A physical cleanup failure leaves the database record in `Error`.

Project IDs are not intentionally recycled, so an old kernel quota record cannot later become the quota policy of an unrelated Volume.

## Capacity and maintenance

Create and grow operations are blocked when:

- backend type is not `LocalFilesystem`,
- backend status is not `Ready`,
- health is `Unhealthy` or `Unknown`,
- maintenance is enabled,
- backend capacity telemetry is unavailable,
- committed capacity would exceed total capacity,
- requested physical growth exceeds currently available capacity.

Tenant quota and backend capacity remain separate checks. Storage overcommit is not allowed.

## Docker Swarm / NFS-Ganesha

Workloads continue to use Docker `local` driver volumes with NFS options:

- `type=nfs`,
- `o=addr=<NFS_GANESHA_SERVER>,nfsvers=<version>,rw`,
- `device=:<logical storagePath>`.

NFS-Ganesha exports the local ResourcePortal storage root under the logical `/rp` namespace. This lets a task on another Ready Swarm node mount the same Volume without a host bind mount and without direct access to the underlying XFS/ext4 filesystem.

Backend validation may launch the existing temporary global Swarm probe service. When remote validation is enabled, every Ready Swarm node must be able to mount the exported namespace read-write.

A one-node Swarm remains valid: the storage host may also run workloads and consume the same export locally.

The production `operation-worker` that performs Volume mutation is constrained to the designated storage node and receives the storage mount read-write. The API is also constrained to the storage/control-plane node in v1 but receives that mount read-only. Other workers do not receive the local storage mount merely because they are part of the Swarm.

## Platform API

Platform administrators can:

- list StorageBackends,
- read a StorageBackend,
- trigger validation,
- enable or disable maintenance.

Tenant APIs do not expose backend mutation.

## Configuration

The v1 storage implementation uses:

- `STORAGE_MOUNT_ROOT` — physical host mount containing ResourcePortal storage,
- `STORAGE_FINDMNT_CLI` — filesystem/mount inspection command,
- `STORAGE_XFS_QUOTA_CLI` — XFS project quota command; defaults to `xfs_quota`,
- `STORAGE_SETQUOTA_CLI` — ext4 project quota limit command; defaults to `setquota`,
- `STORAGE_CHATTR_CLI` — ext4 project ID/hierarchy command; defaults to `chattr`,
- `STORAGE_LSATTR_CLI` — project-ID readback command; defaults to `lsattr`,
- `NFS_GANESHA_SERVER`,
- `NFS_GANESHA_VERSION`,
- `STORAGE_BACKEND_RECONCILE_INTERVAL_MS`,
- `STORAGE_REMOTE_VALIDATION_ENABLED`,
- `STORAGE_REMOTE_VALIDATION_TIMEOUT_MS`,
- `STORAGE_REMOTE_VALIDATION_IMAGE`.

Production requires a storage mount using XFS or ext4 with project quotas enabled and a reachable NFS-Ganesha endpoint when remote workload access is enabled.

## Migration from the old CephFS design

The historical Stage 14 migration remains in the migration history. A later migration renames the backend enum value from `CephFS` to `LocalFilesystem`, renames the default backend, resets its validation state and assigns durable project IDs to existing Volume metadata.

That database migration does **not** copy persistent data from an existing CephFS deployment into `STORAGE_MOUNT_ROOT`. Any environment that already contains real CephFS Volume data requires an explicit data-migration procedure before switching workload access to the LocalFilesystem backend.

## Verification

The LocalFilesystem migration is complete only when:

- path-safety tests pass,
- XFS and ext4 validation tests pass,
- missing project-quota mount options are rejected,
- XFS provisioning assigns and verifies project IDs with `xfs_quota`,
- ext4 provisioning assigns the project hierarchy and enforces limits with `setquota`,
- non-root quota mutation is rejected before filesystem mutation,
- resize preserves the project ID and grows quota,
- failed provisioning cleans up the new directory,
- used-size measurement does not follow symlinks,
- Prisma generates the `LocalFilesystem` backend type and `storageProjectId`,
- Volume transaction-boundary tests prove physical work occurs outside the quota transaction,
- stack rendering still produces NFS-Ganesha driver options,
- the real Docker Swarm workflow provisions a real XFS filesystem with project quotas and validates the NFS-Ganesha path,
- the API runtime image builds with the required quota tools and remains non-root by default,
- lint, unit tests and build pass,
- existing real Docker Swarm and federation integration workflows remain green.
