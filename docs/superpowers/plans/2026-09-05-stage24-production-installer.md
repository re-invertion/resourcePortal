# Stage 24 Production Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the ResourcePortal Production Installer v1 and production packaging required to bootstrap, join, upgrade, reconfigure and diagnose supported Docker Swarm installations.

**Architecture:** A zero-runtime-dependency Bash installer orchestrates host preparation and a generated production Swarm stack. Existing LocalFilesystem/XFS-ext4 runtime contracts from Stages 14/16 remain authoritative; Stage 24 adds host orchestration, production images, Swarm Secret loading, release metadata, enrollment and lifecycle operations around them.

**Tech Stack:** Bash, Docker Engine/Swarm, NFS-Ganesha, UFW, XFS/ext4 project quota, Node.js 24 runtime images, NestJS, React/Vite, Prisma, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-05-production-installer-v1-design.md`

## Global Constraints

- Supported OS: Debian 12/13, Ubuntu Server 24.04/26.04.
- Installer itself requires only Bash and standard host tooling; no Python/Node prerequisite.
- Production Installer v1 uses only `LocalFilesystem` with XFS default and ext4 alternative.
- No CephFS, no software RAID/mdadm management, no backup/restore subsystem in v1.
- One active storage host/backend; storage host is an acknowledged SPOF.
- Production login requires validated domain + HTTPS; no temporary HTTP login.
- Production images are immutable release images; production hosts never build source.
- Secrets must not be persisted in installer config/logs and runtime secrets use Swarm Secrets/`*_FILE` where supported.

---

### Task 1: Installer core, preflight, config and test harness

**Files:**
- Create: `resourceportal-install.sh`
- Create: `scripts/installer/common.sh`
- Create: `scripts/installer/ui.sh`
- Create: `scripts/installer/system.sh`
- Create: `scripts/installer/config.sh`
- Create: `test/installer/test-core.sh`
- Modify: `package.json`

**Interfaces:**
- Produces `rp_die`, `rp_log`, `rp_require_root`, `rp_detect_os`, `rp_version_ge`, `rp_config_load`, `rp_config_write`, `rp_main`.
- `rp_config_write <path>` serializes only allow-listed non-secret `RP_CFG_*` values and writes mode 0600.

- [ ] Write shell tests for supported/unsupported OS parsing, version comparison, root preflight and secret-free config serialization.
- [ ] Run `bash test/installer/test-core.sh` and verify failures before implementation.
- [ ] Implement entry point and focused core modules with sourcing free of side effects.
- [ ] Add `test:installer` script to root `package.json`.
- [ ] Run installer tests, `bash -n` over all installer files and existing API config tests.
- [ ] Commit `feat(stage24): add production installer core`.

### Task 2: Storage discovery, filesystem, quota and readiness service

**Files:**
- Create: `scripts/installer/storage.sh`
- Create: `scripts/installer/filesystem.sh`
- Create: `scripts/installer/quota.sh`
- Create: `scripts/installer/templates/resourceportal-storage-ready.service`
- Create: `test/installer/test-storage.sh`

**Interfaces:**
- Produces `rp_system_disk`, `rp_device_is_safe_target`, `rp_render_fstab_entry`, `rp_validate_filesystem_type`, `rp_project_quota_mount_options`, `rp_storage_layout_create`, `rp_install_storage_ready_unit`.
- Storage layout uses `${RP_CFG_STORAGE_BASE_PATH}/{volumes,secrets,platform}` and canonical `/mnt/resourceportal/*` runtime paths.

- [ ] Write failing pure-function tests for system-disk exclusion, XFS/ext4 validation, XFS default, UUID/fstab rendering, project-quota options and canonical layout.
- [ ] Implement discovery/validation separately from destructive format/partition functions.
- [ ] Require explicit typed confirmation for destructive actions; empty-disk preparation is GPT + one full-size partition only.
- [ ] Render/install a fail-safe systemd readiness unit that validates mounts/quota before success.
- [ ] Run shell/static tests and existing Stage 14 storage tests.
- [ ] Commit `feat(stage24): prepare local filesystem storage`.

### Task 3: NFS-Ganesha, runtime mounts and storage labels

**Files:**
- Create: `scripts/installer/nfs.sh`
- Create: `scripts/installer/templates/ganesha-resourceportal.conf.tpl`
- Create: `test/installer/test-nfs.sh`

**Interfaces:**
- Produces `rp_render_ganesha_config`, `rp_validate_ganesha_config`, `rp_render_nfs_fstab_entry`, `rp_mount_runtime_namespace`, `rp_apply_storage_labels`.
- Exports are isolated `volumes`, `secrets`, `platform`; `volumes` defaults to Root_Squash and `secrets/platform` are manager-only.

- [ ] Write failing renderer tests asserting export isolation and absence of database paths from workload export.
- [ ] Implement atomic managed Ganesha fragment rendering/validation/reload.
- [ ] Implement local bind mounts on storage host and NFSv4 hard mounts on remote nodes.
- [ ] Gate Docker node labels on successful readiness probes.
- [ ] Run shell tests and Stage 14 stack-storage tests.
- [ ] Commit `feat(stage24): configure nfs storage access`.

### Task 4: Docker, firewall and Swarm host orchestration

**Files:**
- Create: `scripts/installer/docker.sh`
- Create: `scripts/installer/firewall.sh`
- Create: `scripts/installer/swarm.sh`
- Create: `test/installer/test-host-runtime.sh`

**Interfaces:**
- Produces `rp_validate_docker`, `rp_install_docker`, `rp_detect_ssh_port`, `rp_render_ufw_rules`, `rp_swarm_init`, `rp_swarm_join`, `rp_check_manager_quorum`.

- [ ] Write failing tests for Docker version comparison, SSH-first UFW ordering, restricted Swarm/NFS rules and quorum warning logic.
- [ ] Implement Docker CE reuse/install policy without silently replacing incompatible installs.
- [ ] Implement UFW preparation preserving active SSH before enable/reload.
- [ ] Implement Primary Swarm init and additional-node join helpers.
- [ ] Run installer tests and existing Swarm parsing tests.
- [ ] Commit `feat(stage24): orchestrate docker swarm hosts`.

### Task 5: Production API/Web images and secret file loading

**Files:**
- Modify: `Dockerfile`
- Create: `packages/resourceportal-web/Dockerfile`
- Create: `packages/resourceportal-api/src/config/secret-file-loader.ts`
- Modify: `packages/resourceportal-api/src/config/env.validation.ts`
- Modify: `packages/resourceportal-api/src/main.ts`
- Modify relevant worker runners to invoke secret-file loading before config use.
- Create/modify tests under `packages/resourceportal-api/src/config/` and Web packaging checks.

**Interfaces:**
- Produces `loadSecretFiles(env, keys)` that maps `<KEY>_FILE` to `<KEY>` only when direct `<KEY>` is absent, rejects non-absolute/unreadable paths and never logs content.
- API image must run compiled API, compiled workers and Prisma migration CLI without ts-node/dev dependencies.
- Web image runs production SSR server with built assets and production dependencies only.

- [ ] Write failing tests for `*_FILE` precedence, absolute-path enforcement and production validation.
- [ ] Implement loader and call it at every production process entry point.
- [ ] Adjust API runtime image for compiled worker/migration commands and add production Web image.
- [ ] Build both images in CI-compatible local Dockerfile syntax checks/build where available.
- [ ] Run package tests/build/lint.
- [ ] Commit `feat(stage24): add production runtime images`.

### Task 6: Production stack model and bootstrap/final deployment

**Files:**
- Create: `config/production/stack.yml.tpl`
- Create: `scripts/installer/control-plane.sh`
- Create: `scripts/installer/secrets.sh`
- Create: `test/installer/test-control-plane.sh`

**Interfaces:**
- Produces `rp_render_stack <bootstrap|final>`, `rp_ensure_swarm_secret`, `rp_run_migrations`, `rp_deploy_control_plane`.
- Stack consumes exact image digests and Swarm Secrets; PostgreSQL ports are not published.

- [ ] Write failing stack rendering tests for bootstrap/final replica gating, storage placement, no plaintext secret values and no public PostgreSQL ports.
- [ ] Implement deterministic stack rendering from installer config/release metadata.
- [ ] Implement versioned Swarm Secret creation without printing contents.
- [ ] Implement one-shot released-image Prisma migrations before final API/Web/workers.
- [ ] Validate rendered YAML with Docker Compose/Swarm config parser where available.
- [ ] Commit `feat(stage24): render production control plane`.

### Task 7: ZITADEL bootstrap, first admin, domain/ACME and SMTP

**Files:**
- Create/modify installer modules for ZITADEL bootstrap and domain validation.
- Modify `packages/resourceportal-api/scripts/bootstrap-zitadel.ts` only where idempotent non-SMTP first-admin bootstrap needs support.
- Create tests for admin-ID preservation and domain gate.

**Interfaces:**
- Bootstrap returns stable ZITADEL user ID and appends it to existing `PLATFORM_ADMIN_USER_IDS`.
- Web/login final readiness requires validated DNS and HTTPS certificate.

- [ ] Write failing tests for idempotent first admin and preservation of existing platform admin IDs.
- [ ] Implement release-image bootstrap invocation and OIDC client provisioning.
- [ ] Implement DNS/ACME gate that never enables login before valid HTTPS.
- [ ] Implement optional SMTP transport/auth/delivery validation or explicit defer.
- [ ] Run auth/ZITADEL tests and installer tests.
- [ ] Commit `feat(stage24): bootstrap production identity`.

### Task 8: Single-use pinned-TLS node enrollment

**Files:**
- Add Prisma model/migration for installer enrollment token hash/role/expiry/consumed state.
- Add internal enrollment service/controller with atomic redemption.
- Create `scripts/installer/enrollment.sh` and tests.

**Interfaces:**
- Enrollment bundle contains token, endpoint, role, expiry and TLS/SPKI pin, never raw Swarm join token.
- Redemption atomically consumes valid token and returns role-bound Swarm/NFS/bootstrap parameters.

- [ ] Write failing service tests for valid, expired, reused and role-tampered token redemption.
- [ ] Add schema/migration and atomic redemption service.
- [ ] Add pinned-TLS bundle generation/redemption installer flow.
- [ ] Verify worker bundle cannot receive manager credentials.
- [ ] Run API + installer tests.
- [ ] Commit `feat(stage24): add secure swarm enrollment`.

### Task 9: Release metadata, publishing and upgrade lifecycle

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `config/production/release-manifest.schema.json`
- Create: `scripts/installer/releases.sh`
- Create: `scripts/installer/upgrade.sh`
- Create: `test/installer/test-releases.sh`

**Interfaces:**
- Release manifest provides version, installer compatibility, API/Web digest refs, minimum Docker, config schema and migration compatibility.

- [ ] Write failing manifest parser/compatibility tests.
- [ ] Implement stable release discovery and explicit version selection.
- [ ] Add GHCR build/publish workflow with immutable tags/digests and release manifest artifact.
- [ ] Implement safe upgrade state machine refusing incompatible/unsafe rollback.
- [ ] Run workflow/static/schema tests.
- [ ] Commit `feat(stage24): publish and upgrade releases`.

### Task 10: Reconfigure, diagnostics and full Primary flow

**Files:**
- Create: `scripts/installer/reconfigure.sh`
- Create: `scripts/installer/diagnostics.sh`
- Modify: `resourceportal-install.sh`
- Create: `test/installer/test-diagnostics.sh`

**Interfaces:**
- `rp_primary_install` runs the approved ordered phases and persists phase state.
- Diagnostics are read-only; repair operations are separately named and confirmed.

- [ ] Write failing tests for top-level mode dispatch, resume state and non-mutating diagnostics.
- [ ] Implement Primary phase orchestration with checkpoint persistence and idempotent re-entry.
- [ ] Implement supported Reconfigure operations and explicit repair actions.
- [ ] Implement quorum/storage/NFS/control-plane/TLS/version diagnostics.
- [ ] Run full installer suite, build/lint/test and targeted integration tests.
- [ ] Commit `feat(stage24): complete installer lifecycle`.

### Task 11: CI integration and operator documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/swarm-integration.yml`
- Create/update production install/join/upgrade/repair docs.

**Interfaces:**
- CI runs shell syntax/static tests, secret-leak fixtures, stack render validation and safe real-Swarm installer coverage.

- [ ] Add installer test/static jobs and rendered stack validation to CI.
- [ ] Extend real Swarm test for Primary bootstrap-safe mode, enrollment role enforcement and NFS-backed Volume reschedule where runner capabilities allow.
- [ ] Document fresh install, node join, upgrade, reconfigure and diagnostics/repair plus explicit v1 limitations.
- [ ] Run all repository checks locally where environment supports them.
- [ ] Commit `test(stage24): verify production installer`.
