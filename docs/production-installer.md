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

## Interactive TUI

When the installer runs on an interactive terminal, it uses a live full-screen TUI by default. The dashboard shows the ordered installation stages, completed/running/pending/blocked/failed state, overall stage-based progress, the current operation, and recent sanitized activity. Long-running command output remains in `/var/log/resourceportal/installer.log` instead of overwriting the dashboard. Blocking conditions such as DNS propagation stay visible as `blocked` and cannot advance their checkpoint until the condition is satisfied.

Interactive forms and choices use the installer-managed, pinned `gum v0.17.0` binary. The installer verifies the exact release artifact checksum before executing a downloaded copy. A normal TUI download/initialization problem falls back to the supported text interface; an integrity/checksum failure stops installation. On a minimal fresh Primary host, the preflight/package bootstrap may briefly use text output until the dependencies required to obtain `gum` are available, then the installer promotes itself to the TUI before the remaining configuration prompts.

Use `--non-interactive` to force deterministic line-oriented output with no full-screen terminal controls:

```bash
sudo ./resourceportal-install.sh --mode diagnostics --non-interactive
```

Failure handling in the interactive TUI provides `Retry`, `View details`, and `Exit`. Retry reruns only the failed stage under the existing checkpoint rules; resuming the installer reconstructs completed progress from `/var/lib/resourceportal/installer-state`. `Ctrl+C` and normal exit restore the terminal before termination.

On first run, omitting `--mode` opens the interactive mode chooser. Primary installation asks for missing non-secret settings and collects passwords through password prompts. Where the host state is unambiguous, the installer pre-fills editable defaults instead of requiring manual entry: it derives the primary IPv4 address and cluster CIDR from the default route, reuses that private address for Swarm/data-path/NFS/storage-server defaults, and independently tries to discover the host's public IPv4 over HTTPS for the expected ingress/DNS address. Public-IP discovery validates the response and tries a second provider if the first one is unusable; if no public IPv4 can be discovered, ingress falls back to the detected local advertise address. The proposed ingress value remains editable and later DNS validation is still authoritative. The installer also proposes the single safe blank non-system disk when exactly one candidate exists. The primary release version is not prompted manually: during the release phase the installer queries GitHub Releases and selects the newest stable, non-draft, non-prerelease ResourcePortal release. A valid explicitly configured release remains pinned; if an older persisted value points to a release that no longer exists, the installer falls back to the newest stable release and records the resolved manifest version. On a fresh installation, release compatibility checks enforce the manifest's minimum installer and Docker versions but do not treat the empty `0.0.0` installation state as an upgrade migration source; `migrations.supportedFromVersions` is enforced only when upgrading an already installed ResourcePortal release. Ambiguous or externally defined values such as the public domain, ACME email, administrator email/password and SMTP credentials remain explicit user input. Non-secret replay state is persisted in `/etc/resourceportal/installer.conf`; the current safe configuration is written before the storage-readiness systemd gate is started so resume/readiness works during the initial storage phase, then refreshed again by the final persist phase. Phase checkpoints are stored under `/var/lib/resourceportal/installer-state`.

## Primary installation

Primary is the first Swarm manager and the single authoritative storage host in v1. The installer performs preflight, package preparation, Docker validation/install, LocalFilesystem preparation, UFW, Swarm initialization, NFS-Ganesha, release selection, Swarm Secrets, bootstrap stack, migrations, ZITADEL bootstrap, optional SMTP validation, DNS/ACME gating, final control-plane deployment and enrollment listener startup.
ResourcePortal schema migrations run as a detached, one-shot Swarm service with `restart-condition none`; the installer then polls that task explicitly for `Complete`, `Failed` or `Rejected` instead of letting `docker service create` wait for long-lived service convergence. This avoids false 300-second migration timeouts for successful short-lived Prisma migration jobs.

Storage v1 is XFS or ext4 with project quotas; XFS is the default. The installer does not create software RAID. Existing hardware RAID/LUNs appear as ordinary block devices. On a fresh host, a storage device is proposed automatically only when exactly one blank, signature-free, unmounted, non-system disk exists; multiple or ambiguous candidates require manual selection. The installer checks the exact configured storage mountpoint rather than treating the root filesystem as an existing storage mount. If a new block device must be formatted, the installer shows its identity/signatures, rejects the system disk and requires exact `FORMAT /dev/...` confirmation. In interactive mode an incorrect confirmation is explained and re-prompted instead of failing the storage phase without context; cancelling the prompt returns a clear cancellation message and leaves the disk untouched. After creating a GPT partition, the installer waits for udev/kernel propagation and for the resulting partition block device to become usable before invoking `mkfs`, avoiding a partition-creation race on real hosts.

Canonical storage paths are:

```text
/srv/resource-portal/storage/{volumes,secrets,platform}
/mnt/resourceportal/{volumes,secrets,platform}
```

The Primary mounts these runtime namespaces using the installer contract `rp_mount_runtime_namespace <mode> <namespace> <source>` and treats every mount failure as fatal. Before the bootstrap stack is deployed, `/mnt/resourceportal/platform` must be an actual mountpoint; the installer then creates and verifies the PostgreSQL bind-source directories `/mnt/resourceportal/platform/databases/resourceportal-postgres`, `/mnt/resourceportal/platform/databases/zitadel-postgres`, plus `/mnt/resourceportal/platform/fencing`. The database bind roots are owned by the numeric `postgres` UID/GID resolved from the exact immutable PostgreSQL release image and use mode `0700`, so the official PostgreSQL entrypoint can continue after dropping root privileges. The ZITADEL bootstrap PAT directory is likewise owned by the numeric `zitadel` UID/GID resolved from the exact immutable ZITADEL release image, allowing `start-from-init` to write `admin.pat` without making the directory world-writable. This prevents Swarm from starting platform databases on accidental or inaccessible directories from the system filesystem. Additional-node and address-migration NFS remounts use the same mode-first contract.

The default physical root may be overridden with a validated custom path.

## PostgreSQL single-writer fencing

Both ResourcePortal PostgreSQL and ZITADEL PostgreSQL run through `/usr/local/bin/resourceportal-postgres-fence`. The wrapper acquires an exclusive lock under `/mnt/resourceportal/platform/fencing` before launching PostgreSQL. Swarm may reschedule a database task to another manager with `resourceportal.storage.platform=true`, but the replacement remains fail-closed while another writer still owns the shared-storage lock. The installer provisions the fencing script from `packages/resourceportal-postgres/postgres-fence.sh` to `/etc/resourceportal/postgres-fence.sh` before bootstrap, and the Swarm config reads that exact host path. Bootstrap now fails closed if this artifact cannot be created; migrations also repair an older stale bootstrap checkpoint when the artifact is missing.

## Add node

Additional nodes use a 30-minute, single-use, role-bound enrollment bundle. The bundle contains an enrollment token, endpoint, role, expiry and SPKI pin; it never contains a reusable Swarm join token.

The node validates the pinned enrollment TLS identity, redeems the token, configures the private firewall, joins Swarm, mounts the role-appropriate NFS namespaces and calls the completion endpoint. The Primary then verifies the joined node and applies allowed labels. Worker bundles cannot obtain manager credentials.

## Production image publication

ResourcePortal production images are published in GHCR with `org.opencontainers.image.source` pointing at the public `re-invertion/resourcePortal` repository. The release workflow logs out of GHCR after publishing and verifies anonymous access to the exact API, Web and fenced PostgreSQL image digests before it updates the GitHub Release manifest. Controlled manual republish is supported for recovery of an existing semantic release version. A release is not considered publishable when any required ResourcePortal image still requires GHCR authentication.

## Upgrade

Upgrade consumes a release manifest containing exact image digests, installer compatibility, minimum Docker version, config schema and migration rollback policy. `latest` is rejected. Images are pulled before migration/deploy. Automatic rollback is refused when the selected release declares an irreversible migration policy.

## Reconfigure

Supported v1 reconfiguration is deliberately controlled. The installer supports domain/ACME changes, SMTP validation, versioned rotation of the cookie signing secret and internal worker token, manager control-plane/ingress participation, and safe local Swarm/NFS address migration using drain/remount sequencing. Storage data migrations are not performed automatically.

## Diagnostics

Diagnostics are read-only. Explicit repair actions use `--repair` and require exact `REPAIR <action>` confirmation. They inspect OS, Docker, Swarm/quorum, storage filesystem/quota/runtime mounts, NFS-Ganesha, storage readiness, stack services, HTTPS/TLS and installed release metadata. Mutating repair operations must remain separate and explicitly confirmed.


## Reset / Factory reset

Reset is a first-class installer mode with three deliberately different scopes:

```bash
sudo ./resourceportal-install.sh --mode reset --scope settings
sudo ./resourceportal-install.sh --mode reset --scope installer-state
sudo ./resourceportal-install.sh --mode reset --scope factory
```

`settings` forgets persisted installer-entered configuration only when the installation is incomplete and no active ResourcePortal control plane exists. `installer-state` additionally clears safe replay/checkpoint state for an incomplete pre-runtime installation, but refuses when protected secrets, databases, runtime mounts or managed Swarm state exist. Neither scope is a shortcut for reinstalling over a live ResourcePortal deployment.

`factory` is intentionally destructive. It removes the ResourcePortal control-plane runtime, ResourcePortal-managed Swarm resources, enrollment state, databases, secrets, ACME state, tenant volumes, platform data, ResourcePortal system configuration, Swarm membership, the dedicated ResourcePortal storage filesystem/partition layout, and installer-owned host dependencies. **There is no preserve-data uninstall mode in this feature.**

Interactive factory reset displays the exact destructive plan and requires the operator to type exactly:

```text
FACTORY RESET RESOURCEPORTAL
```

Non-interactive factory reset requires both destructive opt-ins:

```bash
sudo ./resourceportal-install.sh \
  --mode reset \
  --scope factory \
  --non-interactive \
  --confirm-factory-reset \
  --allow-destructive-storage
```

The storage target is never inferred during factory reset. The installer revalidates the configured block-device identity and stable fingerprint immediately before wipe, rejects the system/root disk relationship, refuses mounted targets, and does not let package-removal overrides bypass disk safety. If ResourcePortal was given only a partition, partition ownership never authorizes zapping the parent disk.

New installations record installer-created host resources in `/var/lib/resourceportal/installer-state/owned-resources`. Pre-existing packages and Docker are not claimed. On legacy installations without provenance, Docker and packages whose ownership cannot be proven are retained by default. The explicit override:

```text
--force-remove-untracked-packages
```

allows removal of only the fixed Docker/package set known to the ResourcePortal installer. It does not enable global package cleanup, `apt-get autoremove`, global firewall reset, or broader disk deletion.

Factory reset refuses to leave Docker Swarm while unrelated Swarm services, configs or secrets are present. Migrate or remove those unrelated resources first; the reset does not delete them automatically.

Factory reset is resumable using `/var/lib/resourceportal/reset-state/factory.state` plus the sanitized `/var/lib/resourceportal/reset-state/factory.plan`. On every rerun, preflight revalidates the already-approved target; completed destructive phases are skipped. A failure after storage wipe therefore continues cleanup instead of reconstructing ResourcePortal or regenerating secrets. The reset plan and journal are removed only by the final successful cleanup stage.

## Security and limitations

Passwords, private keys, raw enrollment tokens, raw Swarm join tokens and SMTP credentials are not written to `installer.conf`. Runtime application secrets are delivered with Docker Swarm Secrets and `*_FILE` loading. The ZITADEL master key is stored as exactly 32 hexadecimal characters without a trailing newline and is published through a versioned Swarm Secret reference, so a resumable bootstrap can repair the legacy newline-terminated representation without rotating the underlying key material or trying to replace an in-use immutable secret. The enrollment listener is exposed only on the private cluster firewall rule and uses pinned TLS.

v1 intentionally does **not** provide CephFS, software RAID management, storage-host HA, or a backup/restore subsystem. The single active storage host remains a storage SPOF. One Swarm manager is supported for bootstrap, while diagnostics recommends three managers for quorum resilience.

Unattended destructive storage additionally requires `--allow-destructive-storage` plus the exact device confirmation; interactive confirmation alone is not treated as unattended consent.


## Resume and bootstrap recovery

Primary installation is resumable, but checkpoints are not treated as proof that runtime state still exists. When the `release` phase has already completed, the installer restores all immutable image references from `/var/lib/resourceportal/installer-state/release.json` before continuing. When the `secrets` phase has already completed, it reconstructs the runtime Swarm secret references from the existing files under `/var/lib/resourceportal/installer-state/secrets` and re-ensures the corresponding Swarm Secrets without generating replacement secret material. Missing required secret-state files fail closed. Before migrations, it verifies that the bootstrap services `postgres-rp`, `postgres-zitadel`, and `zitadel` exist in Swarm; missing services trigger a bootstrap redeploy. If a fresh-install resume has completed `bootstrap` but not `migrations` or `identity`, the installer treats the ZITADEL database as incomplete bootstrap state: it scales ZITADEL and its PostgreSQL service to zero, moves the installer-owned ZITADEL database directory to a timestamped `.incomplete-*` quarantine, and redeploys bootstrap against a fresh ZITADEL database. This recovery is restricted to the pre-identity state and does not touch the ResourcePortal PostgreSQL database. The ZITADEL `start-from-init` service mounts `/mnt/resourceportal/platform/zitadel-bootstrap` at `/zitadel/bootstrap`, matching `FirstInstance.PatPath`; the later ResourcePortal bootstrap job reads the generated PAT from the same host directory. This keeps bootstrap credentials on protected platform storage and avoids partial first-instance setup caused by an unwritable or missing PAT path.

Control-plane deployment is fail-closed. Failure to render the stack, validate it with `docker stack config`, or deploy it with `docker stack deploy` aborts the phase and prevents a false completion checkpoint.
