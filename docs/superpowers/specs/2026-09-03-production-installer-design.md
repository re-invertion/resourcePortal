# ResourcePortal Interactive Production Installer — Design

Date: 2026-09-03
Status: Design approved in chat; pending written-spec review before implementation
Target repository: `re-invertion/resourcePortal`

## 1. Goal

Add a production-grade, interactive ResourcePortal installer that can bootstrap a fresh Debian/Ubuntu server, deploy the ResourcePortal control plane as a Docker Swarm stack, add further Swarm nodes, manage persistent storage exposed to all Swarm nodes over NFS, and later upgrade, reconfigure, diagnose, back up, or restore the installation.

The installer is not a development helper. Production hosts must not build ResourcePortal from source. They install released, versioned public container images.

## 2. Supported operating systems

Initial support is intentionally limited to:

- Debian 12
- Debian 13
- Ubuntu Server 24.04 LTS
- Ubuntu Server 26.04 LTS

The installer must refuse unsupported distributions before making changes.

## 3. Installer architecture

Use a small Bash entry point plus focused Bash modules. The installer must work on a fresh supported host without requiring Python, Node.js, or another application runtime.

Proposed structure:

```text
resourceportal-install.sh
scripts/installer/
  common.sh
  ui.sh
  system.sh
  firewall.sh
  docker.sh
  storage.sh
  raid.sh
  nfs.sh
  swarm.sh
  releases.sh
  secrets.sh
  control-plane.sh
  enrollment.sh
  backup.sh
  restore.sh
  upgrade.sh
  reconfigure.sh
  diagnostics.sh
```

Modules must expose narrow functions and avoid global side effects during sourcing. Destructive actions are separated from discovery/validation so they can be tested independently.

## 4. User interface

Normal execution uses `dialog` or `whiptail` to provide a text UI with menus, forms, password fields, checklists, and explicit confirmation screens. If no supported TUI implementation is usable, the installer falls back to normal terminal prompts.

Top-level modes:

1. Install Primary / Control Plane
2. Add Swarm Node
3. Upgrade ResourcePortal
4. Reconfigure Installation
5. Repair / Diagnostics
6. Backup / Restore

The UI must never print secret values after entry and must avoid sending them to shell tracing or logs.

## 5. Host package policy

The installer runs `apt update` and installs only required packages. It must not run an automatic full `apt upgrade`.

Expected host packages include the tools required for:

- HTTPS downloads and repository keys
- disk/filesystem discovery
- `mdadm` when software RAID is selected
- ext4/XFS tooling
- NFS client/server integration
- UFW
- Docker installation/bootstrap
- DNS and network diagnostics

The exact package set is distribution-specific and must be covered by automated tests.

## 6. Docker policy

If a usable Docker Engine already exists, validate and reuse it. Otherwise install Docker CE from Docker's official repository together with the Compose plugin where required by maintenance tooling.

Validation must verify at least:

- Docker daemon is reachable
- Swarm support is available
- installed Docker version meets ResourcePortal's supported minimum

Do not silently replace an incompatible existing Docker installation.

## 7. Firewall policy

Use UFW on supported hosts. If absent, install it.

Before enabling or changing UFW:

1. detect the current SSH listening port,
2. add an allow rule that preserves the active SSH management path,
3. add only the required ResourcePortal/Swarm/NFS rules,
4. then enable or reload the firewall.

PostgreSQL databases are never exposed publicly.

Public ingress normally exposes only HTTP/HTTPS. Swarm control/data ports and NFS are restricted to configured cluster/private networks whenever an address range can be established safely.

## 8. Primary installation flow

The Primary path performs, in order:

1. OS/root/preflight validation
2. package preparation
3. Docker validation or installation
4. storage discovery and configuration
5. persistent filesystem mount
6. UFW configuration
7. Docker Swarm initialization
8. Primary node labels
9. NFS-Ganesha configuration for workload volumes
10. ResourcePortal release selection
11. control-plane secret generation/import
12. production stack rendering
13. PostgreSQL initialization/migrations
14. ZITADEL bootstrap
15. first Platform Admin bootstrap
16. optional SMTP configuration and validation
17. ingress/domain/DNS/ACME setup
18. stack deployment
19. health and runtime validation
20. installer state persistence

A failed phase must stop subsequent phases and leave enough state for Repair/Diagnostics or safe re-execution.

## 9. Storage model

### 9.1 Initial RAID decision

Before selecting data devices, ask how storage is provided:

1. Configure software RAID with `mdadm`
2. Use an existing hardware RAID / dedicated block device
3. Use a single dedicated disk without RAID

The system/root disk is discovered and excluded from selectable destructive storage targets.

### 9.2 Software RAID

When software RAID is selected:

- show eligible disks with stable identifying information where available,
- allow explicit disk selection,
- always ask for the RAID level even when exactly two disks are selected,
- expose only RAID levels valid for the selected disk count,
- require a destructive confirmation before changing devices,
- create the array through `mdadm`,
- persist assembly configuration required for boot.

At minimum, support RAID 0, 1, 5, 6, and 10 where disk-count rules permit them.

### 9.3 Hardware RAID / dedicated block device

The selected device is treated as dedicated ResourcePortal storage. The installer does not preserve an existing filesystem on that target.

Before formatting it must:

- prove that it is not the active system/root device,
- show device, size, model, current signatures/mounts,
- require an exact destructive confirmation,
- remove stale signatures only after confirmation,
- create a fresh selected filesystem.

### 9.4 Filesystem

Always ask whether to use:

- ext4 (suggested default)
- XFS

Persist the mount in `/etc/fstab` using a stable UUID, not a transient `/dev/sdX` path.

### 9.5 Persistent directory layout

Use standard Linux locations for installer configuration/state and a dedicated storage filesystem for durable ResourcePortal data:

```text
/etc/resourceportal/
  config.env
  installer.conf
  stack.yml

/var/lib/resourceportal/
  installer-state/

/var/log/resourceportal/
  installer.log

/srv/resource-portal/
  databases/
    resourceportal-postgres/
    zitadel-postgres/
  volumes/
  secrets/
  backups/
```

Both ResourcePortal PostgreSQL and ZITADEL PostgreSQL data are stored on `/srv/resource-portal`.

## 10. Persistent workload volumes and NFS

CephFS is not required for the initial installation.

The physical workload volume data lives on the Primary/storage node under `/srv/resource-portal/volumes`. NFS-Ganesha exports the workload volume storage so every Docker Swarm node can access a ResourcePortal Volume even though the backing filesystem is physically mounted only on the storage node.

Conceptually:

```text
Primary/storage node
  RAID or dedicated storage
    /srv/resource-portal/volumes
      -> NFS-Ganesha
          -> Swarm node A
          -> Swarm node B
          -> Swarm node C
```

ResourcePortal-managed Docker volumes must therefore use the NFS-backed production path rather than a host-only bind path when the production installer configuration is active.

NFS exports must not expose PostgreSQL directories or unrelated control-plane data to worker nodes.

This design provides multi-node access to persistent volumes but does not provide storage-server HA: if the single storage/Primary server is unavailable, NFS-backed persistent workloads become unavailable. CephFS remains a later storage-HA upgrade path, not an installation prerequisite.

## 11. Swarm and network addressing

During Primary setup ask separately for:

- Docker Swarm advertise/data address
- NFS service address

The user may provide the same address for both.

The installer validates that the chosen addresses belong to the host and are reachable on the expected interfaces.

Primary initializes one global Docker Swarm, matching ResourcePortal's existing runtime model.

## 12. Control plane as a Swarm stack

Deploy the full ResourcePortal production control plane through `docker stack deploy`.

Logical services:

```text
resourceportal-control-plane
  traefik
  web
  api
  deployment-worker
  operation-worker
  dr-reconciliation-worker
  zitadel
  postgres-rp
  postgres-zitadel
```

The exact process set must match the current API package runners at implementation time.

Stateful services are constrained to the storage node using ResourcePortal-managed node labels. Stateless services may later run on additional manager nodes that are explicitly opted into Control Plane participation.

The production stack must not reuse the current development `docker-compose.yml` as-is.

## 13. Production images and release pipeline

Production hosts never run `npm install` or build ResourcePortal source.

Add release workflows that publish public GHCR images for at least:

- ResourcePortal API/runtime image (also used for worker commands)
- ResourcePortal Web image

Use immutable version tags and publish/record image digests.

The installer queries stable GitHub Releases and presents a list to the administrator. The administrator explicitly chooses the version; the installer does not silently use `latest`.

Each supported release must provide machine-readable installation metadata describing at least:

- ResourcePortal version
- required installer compatibility
- required image references/digests
- supported schema migration path
- minimum Docker version
- relevant configuration-schema version

The current repository has an API Dockerfile but no complete production image publishing path or Web production image pipeline; those are implementation requirements of this design.

## 14. Secrets model

Use a mixed model:

- non-secret configuration in `/etc/resourceportal/`
- sensitive runtime values in Docker Swarm Secrets

Expected secret classes include:

- ResourcePortal PostgreSQL password
- ZITADEL PostgreSQL password
- ZITADEL master key
- ResourcePortal encryption key
- session/cookie secret
- internal worker token(s)
- OIDC client secret
- SMTP password when configured

Where an upstream/current process only supports environment variables, add a controlled entrypoint or application support for `*_FILE`-style loading from `/run/secrets/...` instead of putting plaintext values into `stack.yml` or normal environment files.

Files under `/etc/resourceportal` containing any sensitive transitional material must be root-owned with restrictive permissions and removed once Swarm Secrets are created.

## 15. Secret rotation

`Reconfigure` supports rotation of managed secrets.

For a normal runtime secret:

1. create a new versioned Swarm Secret,
2. update services to consume it,
3. perform rolling update,
4. validate health,
5. remove the old secret only after success.

Credential pairs that must also change inside a database or external system use a service-specific two-phase procedure so the old credential remains usable until the new one is confirmed.

## 16. Authentication and first administrator

Production uses ZITADEL/OIDC, not `AUTH_MODE=dev`.

Primary installation asks for:

- administrator email
- administrator username
- administrator password
- password confirmation

The password is hidden and never logged. Installer-side minimum policy:

- at least 12 characters
- lower-case letter
- upper-case letter
- digit
- special character

The bootstrap creates the first ZITADEL user and grants the corresponding ResourcePortal identity Platform Admin access.

## 17. Domain, ingress, DNS, and ACME

Primary setup asks whether a domain is ready.

If a domain is provided, before enabling ACME the installer verifies that DNS resolves to the intended ingress address(es) or external load balancer and that the ingress path is reachable. It must not repeatedly invoke Let's Encrypt against obviously incorrect DNS.

If DNS is not ready, allow a temporary IP/HTTP installation that can later be converted through `Reconfigure`.

Always ask for a dedicated ACME/Let's Encrypt contact email.

Traefik remains the owner of ACME issuance, renewal, and private certificate material.

When multiple ingress-capable manager nodes exist, ask whether an external load balancer is used:

- with a load balancer: record/validate its public address and treat ingress managers as backends;
- without one: show all ingress-node public addresses and the required A/AAAA records.

Additional managers are separately opted into:

1. ResourcePortal Control Plane participation
2. Traefik/ingress participation

A manager can participate in the Control Plane without being an Internet ingress node.

## 18. SMTP

Primary setup always offers SMTP configuration but permits `configure later`.

When SMTP is supplied, collect at least:

- host
- port
- TLS/STARTTLS mode
- username when required
- password when required
- sender identity
- test recipient

The password is stored as a Swarm Secret.

Before accepting SMTP configuration, test:

1. network connection,
2. TLS/STARTTLS negotiation as selected,
3. authentication when configured,
4. delivery of a test message to the requested recipient.

A failed test allows correction or an explicit choice to defer SMTP.

Current ResourcePortal code/configuration must be extended only where needed to pass supported SMTP settings; the installer must not claim application mail features that the current application does not implement.

## 19. Additional-node installation

Additional nodes are added through a Primary-generated join bundle, not by manually typing all cluster parameters.

A bundle is:

- role-specific (`worker` or `manager`),
- valid for 30 minutes,
- single-use,
- secret-bearing and never logged in plaintext.

Because native Docker Swarm join tokens are reusable until rotated, one-time semantics cannot be implemented by simply embedding the raw Swarm token in a static file. Implement a small ResourcePortal installer-enrollment flow: the Primary stores only a hash of a random enrollment token plus role, expiry, and consumed state. The join bundle carries the random enrollment token and Primary enrollment endpoint. The Additional Node redeems it over a validated TLS connection. Only a valid, unused, unexpired enrollment token receives the role-appropriate Swarm join credentials and cluster parameters; redemption atomically marks it consumed.

The enrollment response supplies only what is required for bootstrap, including:

- manager endpoint
- role-appropriate Swarm join token
- Swarm network parameters
- NFS server address
- cluster identity/expected manager identity
- installer compatibility requirements

The Additional Node then:

1. validates OS,
2. prepares packages,
3. validates/installs Docker,
4. configures UFW,
5. installs NFS client support,
6. validates NFS connectivity,
7. joins Swarm with the fixed role,
8. verifies the resulting node identity/role,
9. for managers, asks whether to participate in Control Plane,
10. for participating managers, separately asks whether to run Traefik/ingress,
11. triggers/recommends manager-side ResourcePortal infrastructure reconciliation.

A worker bundle can never be promoted to a manager bundle by editing a local option.

## 20. Upgrade

The same installer provides `Upgrade ResourcePortal`.

Flow:

1. detect installed version and installer/schema state,
2. fetch compatible stable releases,
3. display available target versions and release notes,
4. select target version,
5. preflight disk/cluster/service health,
6. create a mandatory control-plane backup,
7. verify backup completeness/checksums,
8. validate target migration compatibility,
9. pull target images by immutable digest,
10. run required schema/config migrations,
11. deploy updated stack,
12. validate health and worker operation,
13. record the new version only after success.

### Upgrade failure behavior

If new images fail after a schema change, automatic rollback is allowed only when the release metadata states that the previous application version remains schema-compatible or that a tested migration rollback exists.

When safe, roll back image references to the previous digests and re-run health checks.

When a migration is irreversible and old images are not compatible with the new schema, do not automatically restore the database or pretend an image-only rollback is safe. Stop, preserve the mandatory backup, and present the explicit recovery choices through Repair/Restore.

This is required because Prisma migrations do not inherently provide universal automatic down migrations.

## 21. Backups and restore

No automatic backup schedule is created.

`Backup / Restore` provides manual operations:

- Create backup
- List backups
- Verify backup
- Restore backup

Control-plane backup includes at minimum:

- ResourcePortal PostgreSQL
- ZITADEL PostgreSQL
- ResourcePortal configuration required for reconstruction
- ResourcePortal secret store data required by the application
- installer metadata
- manifest/checksums

Workload Volume contents are not automatically included in the control-plane backup. Volume backup is a separate concern.

Upgrade always forces a fresh verified control-plane backup regardless of manual backup policy.

Restore is explicitly destructive and requires typed confirmation.

## 22. Reconfigure

`Reconfigure` can safely change supported configuration without reinstalling the host.

Initial scope:

- domain / switch from temporary HTTP to HTTPS
- ACME contact email
- SMTP
- Swarm/NFS addresses when a validated migration is possible
- manager Control Plane participation
- manager ingress participation
- selected ResourcePortal non-secret settings
- managed secret rotation

Operations with data-migration consequences must have dedicated preflight and rollback rules rather than rewriting config blindly.

## 23. Repair / Diagnostics

Diagnostics should be useful without making changes. Checks include at least:

- supported OS and required packages
- Docker daemon and Swarm state
- manager quorum visibility
- expected node labels
- UFW rules
- storage mount and filesystem
- `mdadm` state when applicable
- free space/inodes
- NFS-Ganesha status/export
- NFS access from the current node
- control-plane service desired/actual replicas
- PostgreSQL readiness
- ZITADEL readiness
- ResourcePortal `/api/health/live` and `/api/health/ready`
- Traefik/HTTP/HTTPS
- DNS and certificate state
- installed image digests/version consistency

Repair actions are separate, named operations and require confirmation. Diagnostics must not mutate state merely by being run.

## 24. Installer state and replay

Persist non-secret installation choices in:

```text
/etc/resourceportal/installer.conf
```

Support replay/unattended use:

```bash
sudo ./resourceportal-install.sh --config /etc/resourceportal/installer.conf
```

The replay file never contains Swarm Secrets or plaintext credentials. On a fresh server, missing secrets are regenerated where safe or requested interactively; there is no portable encrypted secret bundle in v1.

### Destructive unattended storage

Unattended mode may perform RAID/wipe/format operations only when both conditions are true:

1. an explicit `--allow-destructive-storage` flag is present,
2. exact target devices are provided explicitly and still pass system-disk safety checks.

Without both, unattended execution stops before destructive storage changes.

## 25. Idempotency and resumability

Every non-destructive installer phase should be safe to re-run. State checks precede actions, for example:

- do not reinitialize an already-correct Swarm,
- do not recreate an existing correct UFW rule unnecessarily,
- do not reformat an already-configured storage mount during normal repair/reconfigure,
- do not recreate unchanged secrets,
- do not redeploy unchanged image digests without reason.

Destructive steps are never inferred from partial state. If the installer cannot prove that a destructive continuation is safe, it stops and requests an explicit recovery action.

## 26. Logging and security

Installer logging goes to `/var/log/resourceportal/installer.log` with timestamps and phase/result information.

Rules:

- no passwords, master keys, join bundles, raw enrollment tokens, Swarm join tokens, session secrets, or SMTP credentials in logs;
- disable shell xtrace around all secret handling;
- sanitize command errors that could echo credentials;
- use restrictive umask for temporary secret files;
- delete temporary secret material after importing it into Swarm;
- protect `/etc/resourceportal` and `/var/lib/resourceportal` according to file sensitivity;
- verify HTTPS certificates when contacting GitHub/GHCR/Primary enrollment endpoints;
- pin production images by digest after release selection.

## 27. Required repository changes

Implementation is expected to touch more than the installer scripts. Required areas include:

1. modular installer scripts and tests;
2. production Swarm stack template/rendering;
3. public GHCR release workflow;
4. production Web container image;
5. API/runtime image adjustments needed for all worker commands;
6. Swarm Secret file-loading support for sensitive settings;
7. one-time join-bundle enrollment/redeem support;
8. production NFS volume rendering/provisioning consistent with ResourcePortal Volume semantics;
9. installer-compatible ZITADEL/bootstrap path;
10. SMTP configuration support needed by the selected production flow;
11. upgrade compatibility/release metadata;
12. documentation for fresh install, node join, upgrade, repair, backup, and restore.

## 28. Testing strategy

### Unit/shell tests

Use a shell test framework or repository-consistent test harness to cover pure parsing/decision functions:

- OS detection
- version comparison
- address validation
- filesystem/RAID option validation
- system-disk exclusion
- config serialization without secrets
- release manifest parsing
- secret-name/version logic
- join-bundle expiry/role/consumption rules

### Static checks

- `shellcheck` for installer Bash
- syntax validation for all shell files
- rendered stack YAML validation
- tests that forbidden secrets do not appear in generated config/log fixtures

### Integration tests

Run disposable Linux VMs/containers where feasible for:

- package/bootstrap logic
- Docker detection
- UFW rule rendering
- loopback-device storage/RAID tests
- ext4 and XFS formatting/mount persistence
- NFS export/client access

### Real Docker Swarm CI

Extend real Swarm coverage to validate:

- Primary production-stack bootstrap in a safe CI mode
- Additional worker enrollment and join
- role-specific join enforcement
- an RP-managed NFS-backed Volume accessible when a workload is rescheduled between nodes
- control-plane health checks
- safe release upgrade between test versions where feasible

### Upgrade tests

At minimum test:

- compatible image-only upgrade
- reversible migration rollback path
- irreversible migration failure path refusing unsafe automatic rollback
- mandatory backup failure preventing upgrade

## 29. Acceptance criteria

The design is complete when implementation demonstrates all of the following:

1. A fresh supported Debian/Ubuntu host can run one bootstrap script and complete Primary setup interactively.
2. The installer can configure software RAID, hardware-RAID/dedicated device, or single-disk storage with explicit destructive safety.
3. Both PostgreSQL databases persist on the selected `/srv/resource-portal` storage.
4. ResourcePortal workload Volumes are physically stored on the storage node and are reachable from other Swarm nodes over NFS.
5. The full production control plane runs as a Swarm stack from public, versioned GHCR images.
6. Production authentication uses ZITADEL/OIDC and the installer bootstraps the first Platform Admin.
7. HTTPS is enabled only after successful DNS preflight; temporary HTTP/IP mode remains available.
8. SMTP can be configured and tested or explicitly deferred.
9. A 30-minute, single-use, role-bound join bundle can add workers/managers without exposing a reusable raw Swarm token in the bundle.
10. Additional managers can independently opt into Control Plane and ingress participation.
11. Upgrade requires a verified backup and refuses unsafe rollback across incompatible irreversible schema migrations.
12. Reconfigure, Diagnostics/Repair, and manual Backup/Restore are available from the same installer.
13. Replay mode contains no plaintext secrets and destructive unattended storage requires explicit flags and exact devices.
14. CI includes shell/static coverage and real integration coverage for the critical Swarm/NFS installer path.

## 30. Explicit non-goals for v1

- automatic periodic backup scheduling
- automatic workload Volume backup policy
- automatic Ceph cluster deployment
- transparent storage-server HA when using the single Primary NFS backend
- support for arbitrary Linux distributions
- building ResourcePortal source code on production hosts
- portable secret bundle for unattended disaster reconstruction

CephFS can be added later as a storage-HA backend without changing the core ResourcePortal Volume API semantics.
