# ResourcePortal Installer Reset / Factory Reset Design

Date: 2026-09-09
Status: DESIGN APPROVED IN CHAT; WRITTEN SPEC PENDING USER REVIEW
Scope: Production installer reset and factory-reset lifecycle

## 1. Goal

Add a first-class `reset` mode to the ResourcePortal Production Installer so an operator can safely clear installer settings, clear resumable installer state when that is safe, or fully return a ResourcePortal host to a pre-install state.

The design must prevent accidental regeneration of secrets, accidental overwrite of a running installation, accidental deletion of unrelated system configuration, and accidental wipe of the system disk.

## 2. Chosen interface

Reset is a top-level installer mode, not a `reconfigure` action and not a separate uninstall script.

Interactive mode chooser adds:

- `Reset / Clear ResourcePortal`

CLI forms:

```bash
sudo ./resourceportal-install.sh --mode reset --scope settings
sudo ./resourceportal-install.sh --mode reset --scope installer-state
sudo ./resourceportal-install.sh --mode reset --scope factory
```

`reset` is added to `rp_mode_valid` and to the installer usage/help text.

If interactive `--mode reset` is invoked without `--scope`, the installer prompts for exactly one of `settings`, `installer-state`, or `factory`. In `--non-interactive` mode, `--scope` is mandatory. Destructive factory-only flags are rejected for non-factory scopes so they cannot be silently ignored.

## 3. Reset scopes

### 3.1 `settings`

Purpose: forget installer-entered non-secret configuration so an incomplete installation can be re-prompted.

Behavior:

- removes the persisted installer configuration at `/etc/resourceportal/installer.conf`;
- does not remove databases, tenant data, Swarm secrets, release state, enrollment state, or a running control plane;
- does not remove `/etc/resourceportal/stack.yml` unless the installation has never reached runtime deployment;
- is allowed only when the installation is incomplete and no active ResourcePortal control plane is detected;
- refuses if the `final` checkpoint exists or a ResourcePortal stack/service is active;
- on refusal, directs the operator to `reconfigure` for supported live changes or `reset --scope factory` for destructive removal.

This restriction is required because `installer.conf` currently contains both user-entered settings and runtime-critical references. It must not be deleted underneath a running installation.

### 3.2 `installer-state`

Purpose: clear resumable lifecycle state for an incomplete installation when doing so cannot regenerate or orphan protected runtime state.

Behavior:

- removes installer checkpoints and replay state under `/var/lib/resourceportal/installer-state` only when the incomplete installation is still in a safe pre-runtime state;
- may also remove `/etc/resourceportal/installer.conf` when the same safety preconditions as `settings` are met;
- refuses if a completed `final` checkpoint exists;
- refuses if ResourcePortal databases, managed Swarm secrets, active ResourcePortal services, or protected platform runtime state already exist;
- never treats “delete checkpoints and rerun Primary” as a valid reinstall strategy over an existing installation.

The purpose of this scope is recovery from an early failed installation, not reinstalling a live system.

### 3.3 `factory`

Purpose: completely remove ResourcePortal and return the host as closely as safely possible to its state before ResourcePortal installation.

Factory reset is destructive by design and removes all ResourcePortal data, including tenant data.

It removes:

- ResourcePortal control-plane stack and installer-enrollment service;
- ResourcePortal-managed Swarm secrets and configs;
- ResourcePortal databases and ZITADEL database state;
- ResourcePortal ACME / Traefik state;
- ResourcePortal enrollment state;
- all tenant volumes and tenant secret storage;
- all ResourcePortal platform data;
- `/srv/resource-portal/storage` contents;
- ResourcePortal runtime mounts under `/mnt/resourceportal`;
- ResourcePortal-owned `/etc/resourceportal` configuration and generated stack files;
- ResourcePortal installer checkpoints and logs where appropriate;
- ResourcePortal-owned UFW rules, `/etc/fstab` entry, NFS-Ganesha configuration and ResourcePortal systemd units;
- the host's membership in Docker Swarm;
- Docker itself when the installer can prove that ResourcePortal installed it, or when an explicit untracked-package override is supplied;
- `/var/lib/docker` as part of the approved full Docker removal path;
- the ResourcePortal storage filesystem, signatures and partitions on the configured dedicated storage device;
- packages installed by ResourcePortal when ownership can be proven, or when the explicit untracked-package override is supplied.

The approved factory-reset semantics are intentionally a full wipe, not a preserve-data uninstall.

## 4. Confirmation and non-interactive safety

### 4.1 Interactive factory reset

Before destructive work starts, the installer must display a summary containing at least:

- ResourcePortal stack name;
- configured storage device;
- configured storage path;
- whether Docker will be removed;
- whether package ownership is tracked;
- confirmation that tenant volumes and databases will be destroyed;
- confirmation that the host will leave Docker Swarm.

The operator must type exactly:

```text
FACTORY RESET RESOURCEPORTAL
```

Any other value aborts without making destructive changes.

### 4.2 Non-interactive factory reset

`--non-interactive` factory reset is allowed only when both flags are present:

```text
--confirm-factory-reset
--allow-destructive-storage
```

If either is missing, the installer fails closed before the first destructive operation.

### 4.3 Untracked package override

For installations created before ownership tracking exists, automatic package/Docker removal is fail-safe.

The explicit override is:

```text
--force-remove-untracked-packages
```

Without that flag, resources whose installer ownership cannot be proven are retained and reported to the operator.

The override affects only package/Docker ownership checks. It does not bypass storage-device or system-disk safety validation.

## 5. Owned-resources manifest

New installations must track which host resources were actually created or installed by ResourcePortal.

Canonical root-only manifest:

```text
/var/lib/resourceportal/installer-state/owned-resources
```

The file is mode `0600` and is written atomically.

Examples of tracked ownership records:

```text
package nfs-ganesha
package nfs-ganesha-vfs
package xfsprogs
docker installed-by-resourceportal
apt-source /etc/apt/sources.list.d/docker.list
apt-key /etc/apt/keyrings/docker.asc
storage-device /dev/sdb
storage-partition /dev/sdb1
fstab-mount /srv/resource-portal/storage
systemd-unit resourceportal-storage-ready.service
ganesha-config /etc/ganesha/resourceportal.conf
```

Rules:

1. A resource is recorded only if the installer itself created or installed it.
2. Pre-existing packages are not claimed by ResourcePortal.
3. Pre-existing Docker is not claimed by ResourcePortal.
4. Existing system configuration is never globally claimed because ResourcePortal added one entry to it.
5. The manifest contains metadata only, never secret values.
6. Factory reset automatically removes only resources whose ownership is established by this manifest, except where the user supplies the explicit untracked-package override.

## 6. Package ownership tracking

Before `rp_prepare_host_packages` installs packages, the installer records which required packages are already installed.

After successful installation, only packages that changed from “not installed” to “installed” are appended as ResourcePortal-owned packages.

The same pattern applies to Docker:

- if Docker existed and passed validation before `rp_ensure_docker`, it is not owned by ResourcePortal;
- if `rp_install_docker` was required and completed successfully, Docker and the Docker apt source/key created by that path are marked owned.

Factory reset removes only tracked packages by default.

## 7. System configuration ownership

Factory reset must revert only ResourcePortal-specific system changes.

### `/etc/fstab`

Remove only the entry whose mountpoint matches the ResourcePortal storage mount recorded by installer configuration/ownership state. Do not rewrite unrelated entries.

### UFW

Remove only firewall rules added for ResourcePortal. The reset implementation must identify ResourcePortal rules by the exact rule definitions used by the installer; it must not run a global `ufw reset`.

### NFS-Ganesha

Remove `/etc/ganesha/resourceportal.conf` only when it is ResourcePortal-owned. Do not remove global Ganesha configuration unrelated to ResourcePortal.

### systemd

Disable/remove only ResourcePortal-owned units and drop-ins. Run `systemctl daemon-reload` after cleanup.

### Docker apt configuration

Remove `/etc/apt/sources.list.d/docker.list` and `/etc/apt/keyrings/docker.asc` only when they are recorded as ResourcePortal-owned or when the user explicitly enables the untracked-package override.

## 8. Factory-reset execution order

Factory reset uses an explicit, resumable destructive lifecycle. The logical stages are:

```text
preflight
stop-services
remove-stack
remove-swarm-resources
remove-enrollment
remove-system-config
unmount-runtime
leave-swarm
remove-docker
remove-docker-data
wipe-storage
remove-rp-data
remove-packages
remove-installer-state
final-cleanup
```

### 8.1 `preflight`

Before any destructive operation:

- require root;
- load existing installer configuration if present;
- load owned-resources manifest if present;
- detect ResourcePortal stack/services;
- detect non-ResourcePortal Swarm stacks/services/configs/secrets that could be affected by leaving the Swarm;
- resolve the configured storage device and partition;
- resolve the system disk;
- fail if the storage target cannot be determined unambiguously;
- fail if the storage target is the system disk or contains the active root filesystem;
- fail if the storage device does not match recorded/configured ResourcePortal storage ownership strongly enough to wipe safely;
- refuse factory reset if unrelated Swarm workloads/resources are present and leaving the Swarm could destroy or orphan them; the operator must migrate/remove those unrelated workloads first;
- calculate the exact destructive plan shown to the operator;
- complete confirmation handling.

No destructive command runs before preflight succeeds.

### 8.2 `stop-services` / `remove-stack`

- stop/remove the ResourcePortal control-plane stack;
- remove temporary installer-owned services such as enrollment/bootstrap/migration services if present;
- absence of an already-removed service is success.

### 8.3 `remove-swarm-resources`

Remove ResourcePortal-owned Swarm secrets and configs after services no longer reference them.

Names must be matched against ResourcePortal's known logical secret/config names and persisted secret references. Do not bulk-delete unrelated Swarm secrets/configs.

### 8.4 `remove-enrollment`

Remove enrollment listener/container/service and enrollment TLS/state files owned by ResourcePortal.

### 8.5 `remove-system-config`

Remove ResourcePortal UFW rules, fstab entry, Ganesha config and systemd artifacts as defined above.

### 8.6 `unmount-runtime`

Unmount ResourcePortal runtime namespaces and storage mountpoints in dependency-safe order before the underlying storage device is modified.

A target that is already unmounted is success.

### 8.7 `leave-swarm`

The host leaves Docker Swarm.

For the approved single-host factory-reset semantics, the reset may use the necessary force behavior when this host is the manager being destroyed, but only after the ResourcePortal stack/resources have been removed.

### 8.8 `remove-docker`

If Docker ownership is proven, or the untracked-package override is present:

- stop/disable Docker services;
- remove Docker packages installed by the supported Docker install path;
- remove ResourcePortal-owned Docker apt source/key.

Otherwise Docker is retained and reported as untracked.

### 8.9 `remove-docker-data`

When Docker removal is authorized, remove `/var/lib/docker` and ResourcePortal-created Docker runtime state required by the approved full reset.

This step is not executed if Docker ownership is unproven and no override was supplied.

### 8.10 `wipe-storage`

The configured dedicated ResourcePortal storage device is intentionally destroyed.

Before wipe, repeat the system-disk and mount checks immediately before executing destructive disk commands.

The wipe removes:

- ResourcePortal-created filesystem signatures;
- ResourcePortal-created partition signatures/table entries on the dedicated storage disk;
- all ResourcePortal data on that device.

The operation must use explicit block-device targets, never a glob or path-derived guess.

If the installer originally received a partition rather than an entire disk, reset must not automatically destroy a parent disk unless ownership metadata proves that ResourcePortal created/owned the entire disk layout.

### 8.11 `remove-rp-data`

Remove remaining ResourcePortal directories on the system disk, including applicable paths under:

```text
/etc/resourceportal
/mnt/resourceportal
/srv/resource-portal
```

Only remove paths that are part of the ResourcePortal contract and are not separate unrelated mounts.

### 8.12 `remove-packages`

Remove packages marked ResourcePortal-owned while the owned-resources manifest is still available. For legacy untracked installations, remove untracked candidate packages only with `--force-remove-untracked-packages`.

Use package-manager operations that do not indiscriminately autoremove unrelated packages. Any optional dependency cleanup must be constrained to dependencies that can be proven to have been pulled exclusively by ResourcePortal-owned packages.

### 8.13 `remove-installer-state`

The reset lifecycle needs its own checkpoint state to remain resumable through earlier destructive stages.

Therefore the active reset journal must not be deleted until every destructive stage that relies on it has completed.

After package cleanup has consumed the ownership manifest, remove the normal Primary installer state, owned-resources manifest, secret replay files, release state and other ResourcePortal installer state no longer needed for recovery.

### 8.14 `final-cleanup`

- remove the reset journal last;
- run systemd reload as needed;
- report retained untracked resources, if any;
- report that ResourcePortal data and storage were destroyed;
- return success only if all required destructive stages completed.

## 9. Resumability and idempotency

Factory reset is resumable and each stage is idempotent.

A dedicated reset journal records completed reset stages separately from Primary installation checkpoints. It must be stored on the system disk, not on the ResourcePortal storage device being wiped.

Example path:

```text
/var/lib/resourceportal/reset-state/factory.state
```

The reset journal itself is removed only by `final-cleanup`.

Examples of idempotent behavior:

- missing stack: success;
- missing Swarm secret: success;
- already-unmounted mount: success;
- host already outside Swarm: success;
- Docker already removed: success;
- storage signatures already absent: success if the target still passes identity/system-disk safety checks;
- already-removed ResourcePortal config file: success.

If the reset fails after wiping storage but before package removal, a rerun continues from the first incomplete reset stage and must never attempt to reconstruct the destroyed ResourcePortal installation.

## 10. Legacy installation behavior

Existing installations created before owned-resource tracking have incomplete provenance.

Factory reset on such a host may still safely remove ResourcePortal runtime/data whose identity is established by:

- ResourcePortal stack/service names;
- persisted ResourcePortal config;
- known ResourcePortal storage paths;
- configured dedicated storage device;
- known ResourcePortal Swarm secret/config names;
- known ResourcePortal system configuration files.

Package and Docker removal remains fail-safe without provenance.

Default legacy behavior:

- destroy ResourcePortal stack/data/storage after full factory-reset confirmation and disk safety checks;
- leave Docker/packages that cannot be proven installer-owned;
- print retained resources.

With `--force-remove-untracked-packages`, the reset may also remove the known Docker/package set used by the ResourcePortal installer, after displaying that the ownership cannot be proven.

## 11. Storage safety invariants

Factory reset must never wipe a block device unless all of these are true:

1. an explicit ResourcePortal storage device is resolved;
2. the device exists as a block device;
3. the device is not the system disk;
4. the active root filesystem does not reside on the device or any child/parent relation that would be destroyed;
5. the ResourcePortal storage mount has been unmounted;
6. ResourcePortal runtime namespaces backed by it are unmounted;
7. the factory-reset confirmation requirements have been satisfied;
8. non-interactive mode includes `--allow-destructive-storage`;
9. the target identity has not changed between preflight and the actual wipe step.

Any ambiguity fails closed.

## 12. Logging and secret handling

Reset uses the normal installer log infrastructure but never logs secret values.

The destructive plan may contain:

- package names;
- resource names;
- mountpoints;
- block-device paths;
- service/stack names.

It must not contain:

- secret contents;
- passwords;
- enrollment tokens;
- Swarm join tokens;
- OIDC client secrets;
- ZITADEL PAT contents;
- private keys.

## 13. TUI behavior

The interactive reset flow uses the existing installer UI primitives.

For `factory`:

1. show reset scope selection;
2. show destructive summary;
3. require exact confirmation phrase;
4. switch to a reset dashboard showing destructive stages and activity;
5. on recoverable stage failure offer `Retry`, `View details`, `Exit` using existing failure semantics;
6. resume from the reset journal on rerun.

The dashboard must clearly distinguish factory reset from Primary installation so an operator cannot mistake destructive progress for installation progress.

## 14. Files/components expected to change during implementation

The implementation is expected to introduce a focused reset component rather than place destructive logic directly in the entrypoint.

Likely files:

- `resourceportal-install.sh` — new mode, CLI flags and dispatch;
- `scripts/installer/reset.sh` — reset scopes, confirmation, lifecycle and cleanup actions;
- `scripts/installer/ownership.sh` — owned-resource manifest helpers;
- `scripts/installer/lifecycle.sh` — package ownership hooks and safe integration points;
- `scripts/installer/docker.sh` — Docker ownership recording;
- `scripts/installer/filesystem.sh` / `storage.sh` — storage ownership recording and safe wipe helpers;
- `scripts/installer/firewall.sh` — exact ResourcePortal rule removal helper;
- `scripts/installer/nfs.sh` — ResourcePortal-specific Ganesha cleanup helper;
- installer tests for reset, ownership and destructive-storage safety;
- `docs/production-installer.md` — operator-facing reset documentation.

The exact file split may be refined during implementation, but reset lifecycle and ownership tracking remain isolated responsibilities.

## 15. Testing requirements

Implementation follows test-driven development.

Required coverage includes at least:

### Interface

- `reset` is a valid mode;
- supported scopes are exactly `settings`, `installer-state`, `factory`;
- invalid scope fails;
- help text documents reset and destructive flags.

### Settings/state safety

- settings reset succeeds for a safe incomplete installation;
- settings reset refuses a live/final installation;
- installer-state reset refuses when protected secrets/databases/runtime exist;
- deleting checkpoints can never silently turn a live installation into a fresh Primary run.

### Confirmation

- wrong interactive phrase aborts;
- non-interactive factory reset without `--confirm-factory-reset` aborts;
- non-interactive factory reset without `--allow-destructive-storage` aborts;
- correct explicit confirmation proceeds.

### Ownership

- pre-existing packages are not recorded as ResourcePortal-owned;
- newly installed packages are recorded;
- pre-existing Docker is not recorded as ResourcePortal-owned;
- installer-installed Docker is recorded;
- manifest is root-only and contains no secrets.

### System cleanup

- only ResourcePortal fstab entry is removed;
- unrelated fstab entries survive;
- only ResourcePortal UFW rules are removed;
- unrelated UFW rules survive;
- only ResourcePortal Ganesha/systemd files are removed;
- unrelated configuration survives.

### Swarm/runtime cleanup

- only ResourcePortal stack/services/secrets/configs are removed;
- unrelated Swarm resources cause preflight refusal rather than being destroyed by `leave-swarm`;
- absence of already-removed resources is idempotent success.

### Storage safety

- system disk is always rejected;
- root backing device is always rejected;
- ambiguous device identity is rejected;
- mounted target is rejected until unmounted;
- exact configured/owned dedicated disk can be wiped after confirmation;
- partition-only ownership does not authorize parent-disk destruction;
- device identity is revalidated immediately before wipe.

### Legacy behavior

- untracked Docker/packages are retained by default;
- override allows removal of the known installer package set;
- override does not bypass disk safety.

### Resumability

- reset journal survives partial failure;
- rerun skips completed stages;
- rerun after storage wipe continues cleanup without reconstructing RP;
- final cleanup removes reset journal only after all required stages complete.

### End-to-end

Use an isolated disposable environment to verify a full factory-reset lifecycle from an installer-created single-node ResourcePortal host to:

- no ResourcePortal stack/services;
- no ResourcePortal Swarm membership;
- no ResourcePortal storage filesystem/partitions on the dedicated test disk;
- no ResourcePortal config/state/data;
- Docker removed when installer-owned;
- installer-owned packages removed;
- unrelated host files/configuration preserved.

No destructive factory-reset test may run against a shared or production host.

## 16. Non-goals

This design does not add:

- a preserve-tenant-data uninstall mode;
- cluster-wide multi-node decommission orchestration;
- backup creation before reset;
- automatic restoration after factory reset;
- global firewall reset;
- global package-manager autoremove;
- wiping arbitrary disks not explicitly tied to ResourcePortal;
- removal of unrelated workloads from other hosts/clusters.

## 17. Success criteria

The feature is complete when:

1. reset is a first-class installer mode;
2. safe `settings` and `installer-state` reset scopes fail closed around live/protected runtime state;
3. factory reset destroys the approved ResourcePortal runtime, data, Swarm membership, Docker state, dedicated storage and installer-owned host dependencies;
4. unrelated host configuration is preserved;
5. package/Docker ownership is tracked for new installations;
6. legacy installations remain safe by default and require explicit override for untracked package/Docker removal;
7. storage wipe can never target the system/root device through normal or resumed execution;
8. factory reset is resumable and idempotent;
9. interactive and non-interactive confirmation rules are enforced;
10. automated tests and isolated end-to-end verification cover the destructive lifecycle.
