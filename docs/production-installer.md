# ResourcePortal Production Installer v1

`resourceportal-install.sh` is the production host installer for ResourcePortal. It is intended for Debian 12/13 and Ubuntu Server 24.04/26.04 and must be run as root.

## Supported modes

```bash
sudo ./resourceportal-install.sh --mode primary
sudo ./resourceportal-install.sh --mode add-node --bundle ./resourceportal-node.bundle
sudo ./resourceportal-install.sh --mode upgrade --manifest ./release-manifest.json
sudo ./resourceportal-install.sh --mode reconfigure --action domain
sudo ./resourceportal-install.sh --mode diagnostics
```

On first run, omitting `--mode` opens the interactive mode chooser. Primary installation asks for missing non-secret settings and collects passwords through password prompts. Non-secret replay state is persisted in `/etc/resourceportal/installer.conf`; phase checkpoints are stored under `/var/lib/resourceportal/installer-state`.

## Primary installation

Primary is the first Swarm manager and the single authoritative storage host in v1. The installer performs preflight, package preparation, Docker validation/install, LocalFilesystem preparation, UFW, Swarm initialization, NFS-Ganesha, release selection, Swarm Secrets, bootstrap stack, migrations, ZITADEL bootstrap, optional SMTP validation, DNS/ACME gating, final control-plane deployment and enrollment listener startup.

Storage v1 is XFS or ext4 with project quotas; XFS is the default. The installer does not create software RAID. Existing hardware RAID/LUNs appear as ordinary block devices. If a new block device must be formatted, the installer shows its identity/signatures, rejects the system disk and requires exact `FORMAT /dev/...` confirmation.

Canonical storage paths are:

```text
/srv/resource-portal/storage/{volumes,secrets,platform}
/mnt/resourceportal/{volumes,secrets,platform}
```

The default physical root may be overridden with a validated custom path.

## PostgreSQL single-writer fencing

Both ResourcePortal PostgreSQL and ZITADEL PostgreSQL run through `/usr/local/bin/resourceportal-postgres-fence`. The wrapper acquires an exclusive lock under `/mnt/resourceportal/platform/fencing` before launching PostgreSQL. Swarm may reschedule a database task to another manager with `resourceportal.storage.platform=true`, but the replacement remains fail-closed while another writer still owns the shared-storage lock.

## Add node

Additional nodes use a 30-minute, single-use, role-bound enrollment bundle. The bundle contains an enrollment token, endpoint, role, expiry and SPKI pin; it never contains a reusable Swarm join token.

The node validates the pinned enrollment TLS identity, redeems the token, configures the private firewall, joins Swarm, mounts the role-appropriate NFS namespaces and calls the completion endpoint. The Primary then verifies the joined node and applies allowed labels. Worker bundles cannot obtain manager credentials.

## Upgrade

Upgrade consumes a release manifest containing exact image digests, installer compatibility, minimum Docker version, config schema and migration rollback policy. `latest` is rejected. Images are pulled before migration/deploy. Automatic rollback is refused when the selected release declares an irreversible migration policy.

## Reconfigure

Supported v1 reconfiguration is deliberately controlled. The installer supports domain/ACME changes, SMTP validation, versioned rotation of the cookie signing secret and internal worker token, manager control-plane/ingress participation, and safe local Swarm/NFS address migration using drain/remount sequencing. Storage data migrations are not performed automatically.

## Diagnostics

Diagnostics are read-only. Explicit repair actions use `--repair` and require exact `REPAIR <action>` confirmation. They inspect OS, Docker, Swarm/quorum, storage filesystem/quota/runtime mounts, NFS-Ganesha, storage readiness, stack services, HTTPS/TLS and installed release metadata. Mutating repair operations must remain separate and explicitly confirmed.

## Security and limitations

Passwords, private keys, raw enrollment tokens, raw Swarm join tokens and SMTP credentials are not written to `installer.conf`. Runtime application secrets are delivered with Docker Swarm Secrets and `*_FILE` loading. The enrollment listener is exposed only on the private cluster firewall rule and uses pinned TLS.

v1 intentionally does **not** provide CephFS, software RAID management, storage-host HA, or a backup/restore subsystem. The single active storage host remains a storage SPOF. One Swarm manager is supported for bootstrap, while diagnostics recommends three managers for quorum resilience.

Unattended destructive storage additionally requires `--allow-destructive-storage` plus the exact device confirmation; interactive confirmation alone is not treated as unattended consent.
