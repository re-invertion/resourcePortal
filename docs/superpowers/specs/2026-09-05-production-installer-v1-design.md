# ResourcePortal Production Installer v1 — Synced Design

Date: 2026-09-05
Status: Approved design synchronized with post-2026-09-04 storage decisions
Source implementation baseline: `main` at `c61c4b9b313369a5c6b4f1f4b1cb6632bc0b7d70`

## Goal

Provide one interactive, production-grade Bash installer for supported Debian/Ubuntu hosts that can bootstrap a ResourcePortal Primary/control-plane node, add Swarm nodes, upgrade and reconfigure an installation, and run diagnostics/repair. Production hosts consume versioned released images and never build ResourcePortal from source.

## Supported systems

- Debian 12
- Debian 13
- Ubuntu Server 24.04 LTS
- Ubuntu Server 26.04 LTS

Unsupported systems are rejected before mutations.

## Installer architecture

Entry point: `resourceportal-install.sh`.

Focused Bash modules live in `scripts/installer/`:

- `common.sh` — logging, error handling, command helpers, permissions
- `ui.sh` — dialog/whiptail with terminal fallback
- `system.sh` — OS/root/preflight/package preparation
- `firewall.sh` — SSH-safe UFW policy
- `docker.sh` — Docker CE validation/install
- `storage.sh` — block device discovery and system-disk exclusion
- `filesystem.sh` — XFS/ext4 preparation, UUID mount persistence
- `quota.sh` — project-quota mount/capability verification
- `nfs.sh` — host-side NFS-Ganesha configuration and client mounts
- `swarm.sh` — Swarm initialization/join and labels
- `releases.sh` — stable release metadata selection and digest validation
- `secrets.sh` — secret generation/import without plaintext persistence
- `control-plane.sh` — production stack render/bootstrap/final deployment
- `enrollment.sh` — single-use, 30-minute, role-bound join enrollment
- `upgrade.sh` — compatible upgrade orchestration
- `reconfigure.sh` — supported non-destructive reconfiguration
- `diagnostics.sh` — read-only checks and explicit repair actions

No Python or Node runtime is required by the installer itself.

## v1 top-level modes

1. Install Primary / Control Plane
2. Add Swarm Node
3. Upgrade ResourcePortal
4. Reconfigure Installation
5. Repair / Diagnostics

Backup/restore is explicitly outside v1.

## Storage

The only v1 persistent backend is `LocalFilesystem`:

```text
StorageBackend.type = LocalFilesystem
filesystemType = XFS | EXT4
```

XFS is recommended/default. ext4 is fully supported.

The installer does not configure software RAID and does not manage `mdadm`. Existing hardware RAID, dedicated block devices and administrator-prepared LUNs are treated as ordinary block devices.

Before destructive formatting, the installer must exclude the system/root disk, display device identity/size/signatures/mounts, and require exact confirmation. Empty disks may be initialized only as GPT with one full-size partition.

The default `StorageBackend.basePath` is `/srv/resource-portal/storage`, but an existing validated filesystem with a custom base path is supported.

Canonical physical layout:

```text
{basePath}/
  volumes/
  secrets/
  platform/
    databases/
      resourceportal-postgres/
      zitadel-postgres/
```

Canonical runtime paths on every eligible node:

```text
/mnt/resourceportal/volumes
/mnt/resourceportal/secrets
/mnt/resourceportal/platform
```

Project quota capability must be verified before storage is marked ready. `resourceportal-storage-ready.service` gates readiness and labels.

## NFS-Ganesha

NFS-Ganesha is a host-side systemd service and an access layer, not a StorageBackend. It exposes isolated NFSv4 exports for `volumes`, `secrets` and `platform` with separate client policy. Workload volume access defaults to `Root_Squash`; `secrets` and `platform` are manager-only by default. NFS is restricted to trusted cluster/private addresses.

The storage host uses local runtime bind mounts. Other eligible nodes mount NFS into the same canonical `/mnt/resourceportal/*` paths.

Readiness labels are applied only after the corresponding local/NFS validation succeeds:

- `resourceportal.storage.volumes=true`
- `resourceportal.storage.secrets=true`
- `resourceportal.storage.platform=true`

## Swarm and control plane

Primary is the first Swarm manager and the single active storage host in v1. One manager is supported for bootstrap; diagnostics warns until the cluster reaches the recommended odd quorum of 3 managers.

The production stack logically contains Traefik, Web, API, deployment worker, operation worker, DR reconciliation, ZITADEL, ResourcePortal PostgreSQL and ZITADEL PostgreSQL. Stateful services are constrained to nodes with required storage readiness.

Traefik runs as exactly one active replica in v1 and stores ACME state under platform storage.

Platform PostgreSQL uses active-passive/single-writer semantics. A second writer is never started unless fencing through the authoritative storage/NFS path confirms the previous writer has lost RW access; uncertainty is fail-closed.

## Production packaging

Release images are public, versioned GHCR images at minimum for:

- API/runtime image, used by API, worker commands and one-shot migrations
- Web image

Release metadata records version, installer compatibility, exact image references/digests, migration compatibility, minimum Docker version and configuration schema version. Installer selection never silently uses `latest`.

Sensitive settings support `*_FILE` loading so Swarm Secrets can be mounted under `/run/secrets` instead of exposed as plaintext environment variables.

## Authentication and ingress

Production uses ZITADEL/OIDC. Installer bootstraps the first user idempotently and appends its stable ZITADEL user ID to `PLATFORM_ADMIN_USER_IDS` without overwriting existing IDs.

A production domain is required before Web Console login is enabled. Installer verifies DNS to the intended ingress address, enables ACME only after validation, waits for a valid HTTPS certificate, then marks login ready. There is no temporary HTTP login or self-signed bootstrap login in v1.

SMTP is optional and may be deferred. If provided, transport/authentication/delivery are validated before acceptance.

## Additional nodes

Primary issues 30-minute, single-use, role-bound enrollment bundles. Bundles carry a random enrollment token, endpoint and pinned enrollment TLS identity, not the reusable raw Swarm token. Primary stores only a token hash, role, expiry and consumed state. Redemption is atomic and returns only the role-appropriate join material and cluster/storage parameters.

## Upgrade and reconfigure

Upgrade selects a compatible release, validates cluster/service health and migration compatibility, pulls immutable digests, runs required migrations, deploys the target stack, verifies health and records the new version only after success. v1 upgrade does not depend on an unimplemented backup subsystem.

Reconfigure supports domain/ACME email, SMTP, safe Swarm/NFS address migration, manager control-plane/ingress participation, supported non-secret settings and managed secret rotation. Storage changes requiring data migration are not automatic.

## Diagnostics

Read-only diagnostics cover OS/packages, Docker, Swarm/quorum, firewall, storage device/filesystem/UUID/fstab/project quota, backend health/capacity/maintenance, storage-ready service and labels, NFS-Ganesha/export isolation/client mounts, control-plane replicas, PostgreSQL single-writer readiness, ZITADEL, RP health endpoints, Traefik/DNS/TLS, image/version consistency and enrollment lifecycle.

Repair actions are explicit and separately confirmed.

## Security and replay

Non-secret state is persisted in `/etc/resourceportal/installer.conf`; installer state lives under `/var/lib/resourceportal/installer-state`; logs live under `/var/log/resourceportal/installer.log`.

Logs never contain passwords, master keys, raw enrollment tokens, Swarm join tokens, SMTP credentials, session secrets or private keys. Temporary secret files use restrictive permissions and are deleted after Swarm Secret import.

Replay mode never stores plaintext secrets. Unattended destructive storage requires both an explicit destructive-storage flag and exact device targets that still pass system-disk safety checks.

## Explicit v1 non-goals

- CephFS/Ceph as active storage backend
- software RAID / `mdadm` management
- storage-server HA
- backup/restore subsystem or scheduled backups
- automatic workload-volume backups
- multi-StorageBackend installer orchestration
- Kerberos for NFS
- source builds on production hosts
- portable unattended secret bundle
- automatic LocalFilesystem-to-CephFS migration
