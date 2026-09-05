# Stage 14 — Wiki Storage Alignment Design

## Status

Approved design. Wiki is the architectural source of truth.

## Goal

Align the ResourcePortal storage implementation with the approved Wiki architecture so that the active v1 storage path uses a single `LocalFilesystem` backend on XFS or ext4, with isolated physical namespaces, canonical runtime mounts, project quotas per tenant Volume, NFS-Ganesha for remote-node access, and explicit Swarm storage readiness labels.

This work must also close the storage-specific gaps currently keeping Stage 5, Stage 6, Stage 7 and Stage 14 partially implemented.

## Source of truth

The ResourcePortal Wiki is authoritative for architecture and required behavior. Existing repository code and earlier repository design documents are implementation history and may be changed when they conflict with Wiki decisions.

The active v1 design intentionally excludes CephFS/Ceph as a production backend.

## Active architecture

```text
HDD / SSD / hardware RAID / LUN
              ↓
          XFS or ext4
              ↓
/srv/resource-portal/storage
├── volumes/
├── secrets/
└── platform/
              ↓
       LocalFilesystem
              ↓
        NFS-Ganesha
              ↓
Docker Swarm RemoteLocations
```

The storage host is the authoritative physical host for the active v1 backend. Additional Swarm nodes consume shared storage through NFSv4.

A single-node installation is a supported first-class topology.

## Filesystem and mount model

### Physical storage root

The canonical physical layout on the storage host is:

```text
/srv/resource-portal/storage/
├── volumes/{tenantId}/{volumeId}
├── secrets/{tenantId}/{appGroupId}/{secretName}
└── platform/
    └── databases/
        ├── resourceportal-postgres/
        └── zitadel-postgres/
```

`StorageBackend.basePath` is configurable but defaults to:

```text
/srv/resource-portal/storage
```

`volumes`, `secrets`, and `platform` are distinct namespaces with distinct exposure rules.

### Canonical runtime mounts

Swarm nodes use the following runtime paths:

```text
/mnt/resourceportal/volumes
/mnt/resourceportal/secrets
/mnt/resourceportal/platform
```

The storage host may satisfy these paths with local bind mounts from the physical filesystem. Other eligible nodes mount the corresponding NFSv4 exports from NFS-Ganesha.

Application workload Volume mounts are sourced from:

```text
/mnt/resourceportal/volumes/{tenantId}/{volumeId}
```

The old runtime convention based on `/rp`, `/rp/volumes`, `/rp/secrets`, or `/mnt/resourceportal-storage` is not part of the active design.

## StorageBackend contract

### Supported backend

`StorageBackendType.LocalFilesystem` is the only active v1 backend type.

The LocalFilesystem adapter must support:

- XFS;
- ext4;
- read/write mount validation;
- project quota capability validation;
- total and available filesystem capacity;
- maintenance state;
- Volume provisioning;
- grow-only Volume quota resize;
- Volume cleanup;
- symlink-safe used-size measurement;
- deterministic physical path resolution under `basePath`.

The adapter must reject logical or physical path traversal outside its configured namespace.

### Health and readiness

A backend may be considered writable only when:

- its type is `LocalFilesystem`;
- the filesystem is XFS or ext4;
- the backing mount is available;
- project quota capability is present;
- the local storage root is writable;
- capacity metadata can be read;
- maintenance is disabled;
- required NFS-Ganesha remote access validation succeeds when remote access validation is enabled.

Validation failure must leave the backend fail-closed for create/resize operations.

## Volume quota model

`Volume.sizeBytes` is the authoritative hard storage limit.

Each Volume receives a durable positive `storageProjectId`.

For XFS and ext4, create and resize must:

1. resolve the physical Volume directory under `{basePath}/volumes/{tenantId}/{volumeId}`;
2. create the directory if needed;
3. assign the project ID;
4. apply the hard quota corresponding to `Volume.sizeBytes`;
5. read back enough state to verify the project assignment and effective quota;
6. only then allow the operation to be finalized in the database.

Shrink remains unsupported in v1.

If quota setup or verification fails, the ResourcePortal operation must fail and preserve a recoverable/consistent domain state.

Quota mutation remains a privileged operation-worker responsibility. The public API process must not require root solely to service normal HTTP requests.

## usedSizeBytes

`usedSizeBytes` remains a measured value, not a billing or quota source of truth.

Measurement must:

- use the resolved physical Volume path;
- return `0` for a missing Volume directory where the existing lifecycle contract expects that behavior;
- not follow symbolic links;
- not count content outside the Volume directory.

## Secrets

The encrypted Secret payload path becomes:

```text
/srv/resource-portal/storage/secrets/{tenantId}/{appGroupId}/{secretName}
```

The Secret storage service continues to use envelope encryption and atomic replacement semantics.

Tenant workloads do not directly mount the `secrets` namespace. Deployment workers read encrypted payloads from the protected store, decrypt them only in memory, and provision Docker Swarm Secrets for workload consumption.

A workload must never receive a bind/NFS mount exposing the ResourcePortal Secret store.

## Platform storage

The internal `platform` namespace is reserved for ResourcePortal-owned persistent data and is not exposed as tenant `Volume` resources.

The design reserves at least:

```text
/srv/resource-portal/storage/platform/databases/resourceportal-postgres
/srv/resource-portal/storage/platform/databases/zitadel-postgres
```

and the corresponding runtime namespace under:

```text
/mnt/resourceportal/platform
```

This Stage 14 work establishes the storage layout and isolation boundary. Production Installer orchestration, active-passive PostgreSQL failover, fencing, ACME placement and upgrade workflows remain Stage 24 responsibilities.

## NFS-Ganesha

NFS-Ganesha is an access layer, not a `StorageBackendType`.

The storage host exports only the namespaces needed by eligible remote nodes.

Required isolation rules:

- tenant workload access must not expose `secrets`;
- tenant workload access must not expose `platform`;
- `volumes` is the workload-facing namespace;
- access to `secrets` and `platform` is restricted to explicitly eligible control-plane nodes;
- the v1 transport is NFSv4 on a trusted private network;
- workload `volumes` use `Root_Squash` by default.

The implementation must not rely on each Docker task independently creating a legacy NFS-backed Docker named volume pointing at `:/rp/...`.

## Swarm runtime integration

ResourcePortal continues to use Docker Swarm for scheduling and placement.

Storage eligibility is represented through node labels:

```text
resourceportal.storage.volumes=true
resourceportal.storage.secrets=true
resourceportal.storage.platform=true
```

Semantics:

- `volumes=true` may be present on managers and workers with the canonical Volume runtime mount ready;
- `secrets=true` is manager/control-plane oriented and indicates the protected secret runtime/storage path is ready where needed by platform processes;
- `platform=true` is manager/control-plane oriented and indicates the internal platform runtime mount is ready;
- the storage host may satisfy canonical runtime mounts locally;
- remote eligible nodes use NFSv4 mounts.

Workload services using a tenant Volume must be constrained to nodes where `resourceportal.storage.volumes=true`.

ResourcePortal must not expose a user-facing physical-node placement control as part of this change.

## Deployment Engine change

The current legacy path that renders Docker `local` volumes with NFS driver options such as:

```text
device=:/rp/volumes/{tenantId}/{volumeId}
```

must be removed from the active v1 deployment path.

For each attached Volume, the generated Swarm service definition must instead use the already-prepared canonical host runtime path:

```text
/mnt/resourceportal/volumes/{tenantId}/{volumeId}
```

with the requested `ro`/`rw` semantics and a placement constraint requiring:

```text
node.labels.resourceportal.storage.volumes == true
```

The exact Compose/Swarm syntax may follow existing renderer conventions, but the semantic contract above is mandatory.

## Single-node behavior

The architecture must work on one server.

For a one-node deployment:

- the node is the Swarm manager and storage host;
- XFS/ext4 is mounted at the configured physical storage filesystem;
- `/srv/resource-portal/storage` contains the three isolated namespaces;
- canonical `/mnt/resourceportal/*` runtime paths are satisfied locally;
- the node carries the required `resourceportal.storage.*` readiness labels;
- workload Volume mounts do not require a second node or remote NFS round-trip to function correctly.

NFS-Ganesha may still be installed/configured for future node enrollment, but single-node workload correctness must not depend on a separate remote consumer.

## Multi-node behavior

For additional Swarm nodes:

- nodes that should run Volume-backed workloads mount the `volumes` export at `/mnt/resourceportal/volumes`;
- readiness is verified before setting `resourceportal.storage.volumes=true`;
- manager/control-plane nodes may additionally mount protected `secrets` and/or `platform` namespaces when required by their assigned role;
- a node must lose the corresponding readiness label when the mount is unavailable or invalid.

The storage host remains a v1 single point of failure. This change does not claim storage HA.

## Migration and compatibility

Historical Prisma migrations that introduced CephFS metadata remain in migration history.

The existing `20260904120000_local_filesystem_storage_backend` migration already converts the backend enum/default metadata to `LocalFilesystem` and allocates durable Volume project IDs. The implementation still needs a follow-up migration or seed/default normalization for the Wiki-approved physical paths so persisted backend metadata no longer defaults to `/rp`, `/rp/volumes`, or `/rp/secrets`.

Existing deployments that contain real data under a previous CephFS layout require an explicit operator migration procedure before switching to the new physical layout. This design does not silently copy arbitrary persistent data.

References to `/rp/...` may remain only where they are intentionally documenting or testing historical migration behavior. They must not remain as active defaults or runtime paths.

## Configuration contract

The implementation must distinguish physical storage from runtime mounts. At minimum the effective configuration must represent:

- physical `StorageBackend.basePath`, default `/srv/resource-portal/storage`;
- physical Volume root `{basePath}/volumes`;
- physical Secret root `{basePath}/secrets`;
- physical platform root `{basePath}/platform`;
- canonical Volume runtime root `/mnt/resourceportal/volumes`;
- canonical Secret runtime/protected root `/mnt/resourceportal/secrets` where needed by platform processes;
- canonical platform runtime root `/mnt/resourceportal/platform`;
- NFS-Ganesha server/address and NFS version when remote mounts are required;
- command paths required for XFS/ext4 project quota validation and mutation.

Configuration naming may reuse existing environment variable patterns where that does not obscure the physical/runtime distinction.

## Failure handling

Storage operations fail closed.

Examples:

- unsupported filesystem → backend unavailable;
- missing project quota support → backend unavailable;
- quota assignment failure → Volume create/resize failure;
- quota verification mismatch → Volume create/resize failure;
- invalid physical path → operation failure;
- missing canonical runtime mount on a node → corresponding readiness label must not be present;
- NFS remote validation failure when required → backend/readiness failure;
- maintenance enabled → create/resize and other storage-expanding writes blocked.

Errors must not result in plaintext Secret leakage or cross-namespace exposure.

## Testing requirements

### Unit tests

Cover at least:

- physical path resolution under `/srv/resource-portal/storage`;
- rejection of path traversal;
- XFS validation;
- ext4 validation;
- missing project quota support;
- project ID assignment;
- quota apply and verification;
- grow-only resize;
- cleanup;
- symlink-safe used-size measurement;
- Secret path generation;
- runtime Volume path rendering;
- storage placement constraint rendering;
- namespace isolation helpers/config generation.

### Integration tests

Cover at least:

- Volume create → physical directory → quota → DB finalization;
- Volume resize → physical quota grow → DB finalization;
- failed quota mutation and recovery state;
- Volume delete and cleanup;
- Secret create/update/read/delete against the new protected physical path;
- Deployment Engine rendering against canonical runtime Volume paths;
- maintenance/capacity behavior.

### Real storage / Swarm smoke

The real integration workflow must validate at least:

- a real XFS project-quota filesystem;
- ext4 project quota in a dedicated test path where feasible in CI;
- physical layout creation;
- real quota enforcement/readback;
- NFS-Ganesha export and mount;
- workload access through `/mnt/resourceportal/volumes`;
- readiness/placement label behavior;
- a Volume-backed Swarm workload;
- cleanup without leaked ResourcePortal stacks/services/mount test artifacts.

The single-node scenario is mandatory. A multi-node scenario should be included where the CI environment can provide a genuine second Swarm node; otherwise the repository must keep a reusable runner that can execute the same scenario in a suitable environment.

## Explicit non-goals

This Stage 14 alignment does not implement:

- CephFS/Ceph as an active v1 backend;
- software RAID management;
- storage HA;
- automatic PostgreSQL failover/fencing;
- Production Installer UI/flow;
- tenant SMB/NFS `NetworkShare` product features;
- user-selected physical node placement;
- Key Vault;
- VM/Proxmox storage integration.

## Completion criteria

Stage 14 can be marked complete only when:

1. active code paths use `LocalFilesystem` only for v1;
2. physical storage follows the Wiki-approved `/srv/resource-portal/storage` namespace model;
3. Secrets use the protected `secrets` namespace;
4. platform internal storage has an isolated `platform` namespace contract;
5. Volume hard limits are enforced and verified with XFS/ext4 project quotas;
6. runtime Volume mounts use `/mnt/resourceportal/volumes/{tenantId}/{volumeId}`;
7. legacy Docker NFS-volume rendering against `:/rp/...` is removed from the active path;
8. Swarm storage eligibility uses the approved `resourceportal.storage.*` labels;
9. NFS-Ganesha access is namespace-isolated;
10. single-node real storage/Swarm smoke passes;
11. required unit/integration tests pass;
12. Stage 5 Secret path, Stage 6 Volume deployment integration and Stage 7 physical Volume lifecycle are re-audited and updated accordingly;
13. Wiki is updated with implementation evidence only after the code and required verification are complete.
