# Stage 14 — StorageBackend / CephFS Design

## Goal

Introduce a platform-owned persistent-storage abstraction whose MVP backend is CephFS. ResourcePortal remains the control plane: it owns metadata, tenant quota policy and orchestration, while CephFS owns physical capacity and directory quota enforcement. NFS-Ganesha is the Docker Swarm access layer and is not modeled as a second storage backend.

## Namespace

The platform CephFS namespace is rooted at `/rp`:

- `/rp/volumes/{tenantId}/{volumeId}` — persistent Volume data
- `/rp/secrets/{tenantId}/{appGroupId}/{secretName}` — filesystem-backed secret namespace

The default StorageBackend uses:

- `basePath=/rp`
- `volumeBasePath=/rp/volumes`
- `secretBasePath=/rp/secrets`

ResourcePortal stores the logical CephFS path in `Volume.storagePath`. Control-plane filesystem operations translate that path through `CEPHFS_MOUNT_ROOT`; workload access uses the logical path through NFS-Ganesha.

## Data model

`StorageBackend` is platform-owned and has:

- `id: uuid`
- `name: string`
- `type: CephFS`
- `basePath`
- `volumeBasePath`
- `secretBasePath`
- `status: Ready | Error`
- `health: Healthy | Degraded | Unhealthy | Unknown`
- `maintenance: boolean`
- `capacityTotal: bytes | null`
- `capacityAvailable: bytes | null`
- `lastValidatedAt: datetime | null`
- `lastValidationError: string | null`

`Volume.storageBackendId` is required and references the backend. The migration creates one default CephFS backend and assigns existing Volumes to it.

## CephFS adapter

A backend adapter owns physical storage behavior. The CephFS implementation:

1. maps logical backend paths to the configured local CephFS mount,
2. creates Volume directories,
3. applies `ceph.quota.max_bytes`,
4. reads the quota back and rejects a mismatch,
5. grows quota before changing `Volume.sizeBytes`,
6. removes the Volume directory during cleanup,
7. measures used bytes recursively without following symlinks,
8. reads Ceph health and capacity from the Ceph CLI.

Volume shrink remains unsupported.

## Health, capacity and maintenance

Full backend validation updates persisted backend telemetry. `HEALTH_OK`, `HEALTH_WARN` and `HEALTH_ERR` map to `Healthy`, `Degraded` and `Unhealthy`. Capacity is read from `ceph df --format json` and persisted as total and available bytes.

Create and grow operations are blocked when:

- backend status is not `Ready`,
- health is `Unhealthy` or `Unknown`,
- maintenance is enabled,
- available backend capacity is lower than the requested physical growth.

Tenant quota and backend capacity are separate checks. Storage overcommit is not allowed.

## Volume lifecycle

Creation pipeline:

1. lock tenant quota,
2. validate tenant quota,
3. choose the default CephFS backend,
4. refresh/check backend health and capacity,
5. create the CephFS directory,
6. apply and verify physical quota,
7. persist Volume with `storageBackendId`, logical storage path and `Ready` status.

Resize pipeline:

1. reject shrink,
2. lock tenant quota,
3. validate tenant quota,
4. refresh/check backend health and capacity for the growth delta,
5. grow and verify CephFS quota,
6. update `sizeBytes` and return to `Ready`.

Delete keeps the Stage 7 `VolumeInUse` guard. Physical cleanup occurs before DB deletion; a cleanup failure keeps the DB record and marks it `Error`.

## Docker Swarm / NFS-Ganesha

Stack generation no longer depends on a host bind mount. Attached Volumes render as Docker `local` driver volumes with NFS options:

- `type=nfs`
- `o=addr=<NFS_GANESHA_SERVER>,nfsvers=<version>,rw`
- `device=:<logical CephFS storagePath>`

This lets a Swarm task recreate access to the same CephFS directory on any required RemoteLocation without mounting CephFS directly on every workload host.

Backend validation includes an NFS-Ganesha probe. When remote probing is enabled, ResourcePortal launches a temporary global Swarm probe service so every Ready Swarm node must be able to mount the exported `/rp` namespace read-write. The probe service is removed after validation.

## Platform API

Platform administrators can:

- list StorageBackends,
- read a StorageBackend,
- trigger validation,
- enable/disable maintenance.

Tenant APIs do not expose backend mutation.

## Configuration

The implementation uses environment configuration for infrastructure-specific endpoints and binaries:

- `CEPHFS_MOUNT_ROOT`
- `CEPH_CLI`
- `CEPHFS_SETXATTR_CLI`
- `CEPHFS_GETXATTR_CLI`
- `NFS_GANESHA_SERVER`
- `NFS_GANESHA_VERSION`
- `STORAGE_BACKEND_RECONCILE_INTERVAL_MS`
- `STORAGE_REMOTE_VALIDATION_ENABLED`
- `STORAGE_REMOTE_VALIDATION_TIMEOUT_MS`
- `STORAGE_REMOTE_VALIDATION_IMAGE`

Production requires `NFS_GANESHA_SERVER` for the CephFS backend.

## Verification

Stage 14 is complete only when unit tests cover path safety, health/capacity parsing, physical quota application/verification, resize and cleanup; Volume lifecycle tests prove backend orchestration; stack rendering proves NFS driver options; migrations/build/lint pass; and the existing real Swarm integration remains green. A live CephFS/NFS-Ganesha smoke may be run where infrastructure is available and its result must be reported separately from simulated command-level CI.