# ResourcePortal Installer Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, fail-closed `reset` installer mode with safe `settings` and `installer-state` scopes plus a resumable destructive `factory` reset that removes ResourcePortal while preserving unrelated host state.

**Architecture:** Keep destructive orchestration isolated in `scripts/installer/reset.sh` and ownership/provenance isolated in `scripts/installer/ownership.sh`. Existing installer modules expose small focused helpers or ownership hooks; the entrypoint only parses reset CLI/TUI input and dispatches. Factory reset persists a sanitized `/var/lib/resourceportal/reset-state/factory.plan` and a separate `/var/lib/resourceportal/reset-state/factory.state` journal on the system disk so resumed execution never depends on already-destroyed ResourcePortal storage or config.

**Tech Stack:** Bash, Docker Engine / Swarm CLI, Debian/Ubuntu `apt`, systemd, UFW, NFS-Ganesha, `lsblk`/`findmnt`/`blkid`/`udevadm`/`wipefs`/`sgdisk`, existing shell test harness, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-09-installer-reset-design.md`

## Global Constraints

- Reset is a top-level installer mode; supported scopes are exactly `settings`, `installer-state`, and `factory`.
- Interactive factory reset requires the exact phrase `FACTORY RESET RESOURCEPORTAL`.
- Non-interactive factory reset requires both `--confirm-factory-reset` and `--allow-destructive-storage` before the first destructive operation.
- `--force-remove-untracked-packages` affects only package/Docker provenance; it never bypasses storage/system-disk checks.
- Ownership manifest path is `/var/lib/resourceportal/installer-state/owned-resources`, mode `0600`, atomically written, and contains metadata only.
- Factory reset journal path is `/var/lib/resourceportal/reset-state/factory.state`; the sanitized execution plan is `/var/lib/resourceportal/reset-state/factory.plan`; both live on the system disk.
- Factory reset is a full wipe: tenant volumes, ResourcePortal/ZITADEL databases, secrets, ACME state, ResourcePortal stack/state, Swarm membership, dedicated ResourcePortal storage, installer-owned Docker, and installer-owned packages are removed when authorized by provenance/override.
- Unrelated fstab entries, UFW rules, Ganesha configuration, systemd units, packages, Docker installations, Swarm resources, and host data must be preserved.
- Factory reset must fail closed on ambiguous storage identity, system/root disk relationships, mounted wipe targets, identity drift, or unrelated Swarm resources.
- No destructive factory-reset E2E may run on a shared or production host.
- Existing installer behavior outside reset remains backward-compatible.

---

## File Structure

### New files

- `scripts/installer/ownership.sh` — atomic ownership manifest helpers and package provenance tracking.
- `scripts/installer/reset.sh` — reset scope validation, protected-state detection, factory plan/preflight, reset journal, destructive lifecycle, cleanup orchestration.
- `test/installer/test-ownership.sh` — ownership manifest/package/Docker provenance unit tests.
- `test/installer/test-reset.sh` — reset interface, safe-scope, confirmation, preflight, cleanup, storage safety, legacy behavior, resumability tests with command stubs.
- `scripts/run-installer-reset-e2e.sh` — guarded full factory-reset verification script for a disposable VM with a dedicated blank test disk.

### Modified files

- `resourceportal-install.sh:1-176` — source new modules, add reset usage/mode/scope/flags, prompt, dispatch.
- `scripts/installer/lifecycle.sh:3-550` — register reset mode and package/storage/system ownership at existing Primary lifecycle integration points.
- `scripts/installer/docker.sh:24-58` — record Docker and Docker apt artifacts only when created by this installer.
- `scripts/installer/filesystem.sh:40-55` — add exact fstab-entry removal helper; keep formatting helper reusable for reset safety tests.
- `scripts/installer/storage.sh:3-135` — add root-device relationship/fingerprint/revalidation helpers used by factory reset.
- `scripts/installer/firewall.sh:26-65` — add exact ResourcePortal-only UFW removal helper.
- `scripts/installer/nfs.sh:83-149` — add ResourcePortal Ganesha cleanup and runtime mount/fstab cleanup helpers.
- `scripts/installer/quota.sh:47-57` — add ResourcePortal storage-ready unit cleanup helper.
- `scripts/installer/swarm.sh:85-160` — add Swarm state/resource inspection helpers that classify unrelated resources before leave.
- `scripts/installer/dashboard.sh:12-45` — add distinct Reset / Factory Reset dashboard mode and factory phase list.
- `package.json:23` — include new ownership/reset tests in `test:installer`.
- `docs/production-installer.md` — document reset scopes, destructive confirmations, legacy provenance behavior, and examples.
- `docs/superpowers/specs/2026-09-09-installer-reset-design.md:4` — mark the written spec approved.

---

### Task 1: Ownership Manifest and Package Provenance

**Files:**
- Create: `scripts/installer/ownership.sh`
- Create: `test/installer/test-ownership.sh`
- Modify: `scripts/installer/lifecycle.sh:126-134`
- Modify: `package.json:23`

**Interfaces:**
- Produces: `rp_ownership_record TYPE VALUE`, `rp_ownership_has TYPE VALUE`, `rp_ownership_values TYPE`, `rp_package_installed PACKAGE`, `rp_install_packages_with_ownership PACKAGE...`.
- Manifest format: one record per line as `<type> <value>`; values used by this installer are package names, device paths, mount paths, or fixed resource identifiers and therefore contain no newlines.
- Consumers: Tasks 2, 5, 6, and 7.

- [ ] **Step 1: Write failing ownership tests**

Create `test/installer/test-ownership.sh` with the repository's existing `failures/assert_eq/assert_status/assert_contains` pattern and these concrete cases:

```bash
manifest="$tmpdir/owned-resources"
RP_OWNERSHIP_MANIFEST="$manifest"
export RP_OWNERSHIP_MANIFEST

rp_ownership_record package nfs-ganesha
rp_ownership_record package nfs-ganesha
assert_eq 1 "$(grep -c '^package nfs-ganesha$' "$manifest")" 'ownership records are idempotent'
assert_eq 600 "$(stat -c '%a' "$manifest")" 'ownership manifest is root-only'
assert_status 0 'ownership lookup finds record' rp_ownership_has package nfs-ganesha
assert_eq 'nfs-ganesha' "$(rp_ownership_values package)" 'ownership values return only payload'

dpkg-query() {
  if [[ "$3" == ca-certificates ]]; then
    printf 'ii \n'
    return 0
  fi
  if [[ "$3" == nfs-ganesha && -e "$tmpdir/after-install" ]]; then
    printf 'ii \n'
    return 0
  fi
  return 1
}
apt-get() {
  [[ "$1" == update ]] && return 0
  [[ "$1" == install ]] || return 1
  : >"$tmpdir/after-install"
}
rp_install_packages_with_ownership ca-certificates nfs-ganesha
assert_status 1 'pre-existing package is not claimed' rp_ownership_has package ca-certificates
assert_status 0 'new package is claimed' rp_ownership_has package nfs-ganesha
```

Also assert that a value containing a newline is rejected and a secret-looking value is never used by tests/implementation.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
bash test/installer/test-ownership.sh
```

Expected: non-zero because `scripts/installer/ownership.sh` and the ownership functions do not exist.

- [ ] **Step 3: Implement atomic ownership helpers**

Create `scripts/installer/ownership.sh` with these concrete contracts:

```bash
#!/usr/bin/env bash

RP_OWNERSHIP_MANIFEST="${RP_OWNERSHIP_MANIFEST:-/var/lib/resourceportal/installer-state/owned-resources}"

rp_ownership_record() {
  local type="$1" value="$2" path="${RP_OWNERSHIP_MANIFEST}" tmp
  [[ "$type" =~ ^[a-z0-9-]+$ ]] || return 1
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  mkdir -p "$(dirname "$path")"
  touch "$path"
  chmod 0600 "$path"
  grep -Fxq -- "$type $value" "$path" && return 0
  tmp="${path}.tmp.$$"
  cat "$path" >"$tmp"
  printf '%s %s\n' "$type" "$value" >>"$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$path"
}

rp_ownership_has() {
  local type="$1" value="$2"
  [[ -r "${RP_OWNERSHIP_MANIFEST}" ]] && grep -Fxq -- "$type $value" "${RP_OWNERSHIP_MANIFEST}"
}

rp_ownership_values() {
  local type="$1"
  [[ -r "${RP_OWNERSHIP_MANIFEST}" ]] || return 0
  awk -v type="$type" '$1 == type { sub(/^[^ ]+ /, ""); print }' "${RP_OWNERSHIP_MANIFEST}"
}

rp_package_installed() {
  dpkg-query -W -f='${db:Status-Abbrev}\n' "$1" 2>/dev/null | grep -q '^ii '
}
```

Implement `rp_install_packages_with_ownership` by collecting packages for which `rp_package_installed` is false before install, running one `apt-get update` and one `DEBIAN_FRONTEND=noninteractive apt-get install -y ...`, then recording only packages that are installed after the command and were absent before it.

- [ ] **Step 4: Route Primary host package installation through provenance tracking**

Source `ownership.sh` before `lifecycle.sh` in `resourceportal-install.sh`. Replace the direct package install body of `rp_prepare_host_packages` with:

```bash
rp_prepare_host_packages() {
  rp_install_packages_with_ownership \
    ca-certificates curl gnupg jq openssl iproute2 util-linux parted gdisk \
    xfsprogs e2fsprogs quota nfs-common nfs-ganesha nfs-ganesha-vfs ufw bind9-dnsutils
}
```

Add `bash test/installer/test-ownership.sh` to `test:installer` in `package.json` immediately before `test-core.sh`.

- [ ] **Step 5: Run focused and full installer tests**

Run:

```bash
bash test/installer/test-ownership.sh
bash test/installer/test-core.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/ownership.sh scripts/installer/lifecycle.sh test/installer/test-ownership.sh package.json resourceportal-install.sh
git commit -m "feat(installer): track owned host packages"
```

---

### Task 2: Record Docker, Storage, fstab, Ganesha, and systemd Ownership

**Files:**
- Modify: `scripts/installer/docker.sh:24-58`
- Modify: `scripts/installer/lifecycle.sh:136-199`
- Modify: `scripts/installer/quota.sh:47-57`
- Modify: `test/installer/test-ownership.sh`
- Modify: `test/installer/test-storage.sh`

**Interfaces:**
- Consumes: Task 1 ownership helpers.
- Produces ownership record types: `docker`, `apt-source`, `apt-key`, `storage-device`, `storage-partition`, `fstab-mount`, `systemd-unit`, `systemd-helper`, `ganesha-config`.
- Factory reset later treats `docker installed-by-resourceportal` as the Docker provenance marker.

- [ ] **Step 1: Add failing tests for pre-existing vs installer-created Docker**

Extend `test/installer/test-ownership.sh` with command stubs around `rp_ensure_docker` / `rp_install_docker`:

```bash
RP_OWNERSHIP_MANIFEST="$tmpdir/docker-owned"
: >"$RP_OWNERSHIP_MANIFEST"
rp_docker_command_present() { return 0; }
rp_validate_docker() { return 0; }
rp_ensure_docker 27.0.0
assert_status 1 'pre-existing Docker is not claimed' rp_ownership_has docker installed-by-resourceportal
```

Then simulate the install path with no Docker binary, absent Docker apt source/key, successful mocked package install and `systemctl`, and assert:

```bash
rp_ownership_has docker installed-by-resourceportal
rp_ownership_has apt-source /etc/apt/sources.list.d/docker.list
rp_ownership_has apt-key /etc/apt/keyrings/docker.asc
```

The test must redirect the source/key paths through `RP_DOCKER_APT_SOURCE` and `RP_DOCKER_APT_KEY` overrides so it never writes `/etc`.

- [ ] **Step 2: Run ownership test and verify RED**

Run:

```bash
bash test/installer/test-ownership.sh
```

Expected: failure because Docker ownership/path override logic is not implemented.

- [ ] **Step 3: Add Docker ownership recording without claiming pre-existing artifacts**

In `docker.sh`, use:

```bash
local keyring="${RP_DOCKER_APT_KEY:-/etc/apt/keyrings/docker.asc}"
local source_path="${RP_DOCKER_APT_SOURCE:-/etc/apt/sources.list.d/docker.list}"
local had_key=false had_source=false
[[ -e "$keyring" ]] && had_key=true
[[ -e "$source_path" ]] && had_source=true
```

After Docker packages install and `systemctl enable --now docker` succeeds:

```bash
rp_ownership_record docker installed-by-resourceportal
[[ "$had_key" == true ]] || rp_ownership_record apt-key "$keyring"
[[ "$had_source" == true ]] || rp_ownership_record apt-source "$source_path"
```

Add a tiny `rp_docker_command_present() { command -v docker >/dev/null 2>&1; }` wrapper so tests can deterministically select the pre-existing/install path. Keep `rp_ensure_docker` behavior: if Docker already exists, only validate it and do not record ownership.

- [ ] **Step 4: Add failing storage/system ownership assertions**

Extend `test/installer/test-storage.sh` using stubs so `rp_primary_prepare_storage` formats `/dev/sdb`, resolves `/dev/sdb1`, and succeeds. Assert the ownership manifest contains:

```text
storage-device /dev/sdb
storage-partition /dev/sdb1
fstab-mount /srv/resource-portal/storage
fstab-mount /mnt/resourceportal/volumes
fstab-mount /mnt/resourceportal/secrets
fstab-mount /mnt/resourceportal/platform
systemd-unit resourceportal-storage-ready.service
systemd-helper /usr/local/lib/resourceportal/storage-ready-check
```

Add an NFS lifecycle test asserting a newly created `/etc/ganesha/resourceportal.conf` is recorded as `ganesha-config`, while a pre-existing file is not newly claimed.

- [ ] **Step 5: Record ownership at existing lifecycle boundaries**

In `rp_primary_prepare_storage`:

- preserve `RP_CFG_STORAGE_DEVICE` as the top-level configured target;
- after a disk partition is created, record `storage-device "$RP_CFG_STORAGE_DEVICE"` and `storage-partition "$partition"`;
- after `rp_persist_filesystem_mount`, record `fstab-mount "$mountpoint"`;
- after each successful `rp_mount_runtime_namespace`, record the matching runtime `fstab-mount`;
- after `rp_install_storage_ready_unit`, record the fixed unit and helper paths.

In `rp_primary_configure_nfs`, capture whether `/etc/ganesha/resourceportal.conf` existed before the call and record it only if this invocation created it.

Do not claim the global `/etc/fstab`, `/etc/ganesha/ganesha.conf`, UFW itself, or pre-existing systemd resources.

- [ ] **Step 6: Run focused tests and full installer suite**

Run:

```bash
bash test/installer/test-ownership.sh
bash test/installer/test-storage.sh
bash test/installer/test-nfs.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/installer/docker.sh scripts/installer/lifecycle.sh scripts/installer/quota.sh test/installer/test-ownership.sh test/installer/test-storage.sh test/installer/test-nfs.sh
git commit -m "feat(installer): track owned runtime resources"
```

---

### Task 3: Add Reset CLI/TUI Interface and Safe Non-Destructive Scopes

**Files:**
- Create: `scripts/installer/reset.sh`
- Create: `test/installer/test-reset.sh`
- Modify: `resourceportal-install.sh:1-176`
- Modify: `scripts/installer/lifecycle.sh:3-5`
- Modify: `package.json:23`

**Interfaces:**
- Produces: `rp_reset_scope_valid SCOPE`, `rp_reset_flags_valid SCOPE`, `rp_reset_settings`, `rp_reset_installer_state`, `rp_reset SCOPE`.
- Uses environment booleans `RP_CONFIRM_FACTORY_RESET`, `RP_ALLOW_DESTRUCTIVE_STORAGE`, `RP_FORCE_REMOVE_UNTRACKED_PACKAGES` set only by CLI flags.
- `rp_reset` is the only entrypoint called by `resourceportal-install.sh` for reset mode.

- [ ] **Step 1: Write failing interface/scope tests**

Create `test/installer/test-reset.sh` and source `common.sh`, `config.sh`, `ownership.sh`, `lifecycle.sh`, then `reset.sh`. Add assertions:

```bash
assert_status 0 'reset mode valid' rp_mode_valid reset
assert_status 0 'settings scope valid' rp_reset_scope_valid settings
assert_status 0 'installer-state scope valid' rp_reset_scope_valid installer-state
assert_status 0 'factory scope valid' rp_reset_scope_valid factory
assert_status 1 'unknown reset scope rejected' rp_reset_scope_valid wipe

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
assert_contains "$entrypoint_source" '--scope' 'help/parser supports reset scope'
assert_contains "$entrypoint_source" '--confirm-factory-reset' 'parser supports factory confirmation flag'
assert_contains "$entrypoint_source" '--force-remove-untracked-packages' 'parser supports legacy package override'
assert_contains "$entrypoint_source" 'Reset / Clear ResourcePortal' 'interactive mode chooser exposes reset'
```

Add direct `rp_main` tests with root/UI/dispatch stubs proving:

- `--mode reset --non-interactive` without `--scope` returns 2;
- `--mode reset --scope settings --confirm-factory-reset` returns 2 because a factory-only flag cannot be silently ignored;
- interactive reset with no scope calls `rp_ui_choice` and can select `settings`.

- [ ] **Step 2: Run test and verify RED**

```bash
bash test/installer/test-reset.sh
```

Expected: non-zero because reset mode/module/flags do not exist.

- [ ] **Step 3: Add reset mode and CLI flags**

Update usage with:

```text
sudo ./resourceportal-install.sh --mode reset --scope settings
sudo ./resourceportal-install.sh --mode reset --scope installer-state
sudo ./resourceportal-install.sh --mode reset --scope factory [--confirm-factory-reset] [--allow-destructive-storage]
```

Add `reset` to `rp_mode_valid`, source `reset.sh`, and add the menu pair:

```bash
reset 'Reset / Clear ResourcePortal'
```

Parse:

```bash
--scope) scope="$2"; shift 2 ;;
--confirm-factory-reset) RP_CONFIRM_FACTORY_RESET=true; export RP_CONFIRM_FACTORY_RESET; shift ;;
--force-remove-untracked-packages) RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true; export RP_FORCE_REMOVE_UNTRACKED_PACKAGES; shift ;;
```

If mode is reset and scope is empty:

```bash
if [[ "$RP_NON_INTERACTIVE" == true ]]; then
  printf '%s\n' '--scope is required for non-interactive reset' >&2
  return 2
fi
scope="$(rp_ui_choice 'ResourcePortal reset' 'Choose reset scope' settings \
  settings 'Clear saved installer settings' \
  installer-state 'Clear safe incomplete installer state' \
  factory 'Factory reset (DESTROYS ALL RESOURCEPORTAL DATA)')" || return 1
```

Call `rp_reset_flags_valid "$scope"` before dispatch. Dispatch reset with `rp_reset "$scope"`.

- [ ] **Step 4: Implement safe-scope state detection and cleanup**

In `reset.sh`, define canonical paths:

```bash
RP_PRIMARY_STATE_FILE="${RP_PRIMARY_STATE_FILE:-/var/lib/resourceportal/installer-state/primary.state}"
RP_INSTALLER_CONFIG_FILE="${RP_INSTALLER_CONFIG_FILE:-/etc/resourceportal/installer.conf}"
RP_INSTALLER_STATE_DIR="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}"
```

Implement:

```bash
rp_reset_final_checkpoint_present() {
  rp_phase_done "$RP_PRIMARY_STATE_FILE" final
}

rp_reset_active_control_plane() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  docker service ls --filter "label=com.docker.stack.namespace=${RP_CFG_STACK_NAME:-resourceportal-control-plane}" \
    --format '{{.Name}}' 2>/dev/null | grep -q .
}
```

Implement `rp_reset_protected_state_present` as a disjunction of:

- any file under `${RP_INSTALLER_STATE_DIR}/secrets`;
- database directory content under `${RP_CFG_STORAGE_BASE_PATH:-/srv/resource-portal/storage}/platform/databases/resourceportal-postgres` or `zitadel-postgres`;
- any mounted `/mnt/resourceportal/{volumes,secrets,platform}`;
- any ResourcePortal-managed Swarm secret detected by a helper introduced in Task 5.

For Task 3 tests, make Swarm-secret detection an overrideable function returning false until Task 5 fills the real implementation.

`rp_reset_settings` must refuse when final checkpoint or active control plane exists, otherwise remove only the canonical installer config.

`rp_reset_installer_state` must additionally refuse protected state. On success remove explicit replay/checkpoint paths while preserving `owned-resources`:

```bash
rm -f "$RP_INSTALLER_STATE_DIR/primary.state" "$RP_INSTALLER_STATE_DIR/release.json" "$RP_INSTALLER_STATE_DIR/zitadel-bootstrap.json"
rm -rf "$RP_INSTALLER_STATE_DIR/secrets" "$RP_INSTALLER_STATE_DIR/enrollment" "$RP_INSTALLER_STATE_DIR/identity-bootstrap"
rm -f "$RP_INSTALLER_CONFIG_FILE"
```

It must not `rm -rf "$RP_INSTALLER_STATE_DIR"` because that would discard package/storage provenance.

- [ ] **Step 5: Add safety regression tests**

Test all four cases with temporary paths and function stubs:

1. incomplete/no-runtime settings reset removes config;
2. `final` checkpoint refuses settings reset and preserves config;
3. active ResourcePortal service refuses settings reset;
4. secrets/database/runtime mount evidence refuses installer-state reset and preserves `primary.state` plus ownership manifest.

- [ ] **Step 6: Run focused/full tests**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-core.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add resourceportal-install.sh scripts/installer/reset.sh scripts/installer/lifecycle.sh test/installer/test-reset.sh package.json
git commit -m "feat(installer): add safe reset scopes"
```

---

### Task 4: Factory Preflight, Sanitized Plan, Confirmation, and Storage Identity

**Files:**
- Modify: `scripts/installer/reset.sh`
- Modify: `scripts/installer/storage.sh:3-135`
- Modify: `scripts/installer/swarm.sh:85-160`
- Modify: `test/installer/test-reset.sh`
- Modify: `test/installer/test-storage.sh`

**Interfaces:**
- Produces: `rp_storage_root_source`, `rp_storage_related_to_root DEVICE`, `rp_storage_fingerprint DEVICE`, `rp_reset_factory_preflight`, `rp_reset_factory_plan_write`, `rp_reset_factory_plan_load`, `rp_reset_factory_confirm`.
- Sanitized plan keys: `stack`, `storage_device`, `storage_partition`, `storage_base_path`, `storage_mountpoint`, `storage_fingerprint`, `docker_remove`, `package_tracking`, `force_untracked_packages`.
- The plan never contains passwords, tokens, secret values, join tokens, PATs, or private keys.

- [ ] **Step 1: Write failing storage safety tests**

In `test/installer/test-storage.sh`, stub `findmnt`, `lsblk`, and `readlink` to prove:

```bash
assert_status 1 'root backing disk is rejected' rp_storage_related_to_root /dev/sda
assert_status 1 'root backing partition is rejected' rp_storage_related_to_root /dev/sda2
assert_status 0 'unrelated storage disk is accepted by root relation check' rp_storage_related_to_root /dev/sdb
```

Add fingerprint tests with deterministic mocked `lsblk`/`udevadm` output and assert that a missing stable identity returns non-zero instead of falling back to a path-only guess.

- [ ] **Step 2: Write failing factory confirmation/preflight tests**

In `test-reset.sh`, cover:

```bash
RP_NON_INTERACTIVE=true
RP_CONFIRM_FACTORY_RESET=false
RP_ALLOW_DESTRUCTIVE_STORAGE=true
assert_status 1 'noninteractive factory requires explicit factory flag' rp_reset_factory_confirm

RP_CONFIRM_FACTORY_RESET=true
RP_ALLOW_DESTRUCTIVE_STORAGE=false
assert_status 1 'noninteractive factory also requires destructive storage flag' rp_reset_factory_confirm
```

For interactive mode stub `rp_ui_input` to return `wrong` then `FACTORY RESET RESOURCEPORTAL`; assert wrong input aborts without calling a destructive marker function and exact input succeeds.

Add preflight cases for missing/ambiguous storage target, system/root target, changed fingerprint, and unrelated Swarm resource detection.

Also stub an approved plan and assert `rp_reset_factory_summary` contains the stack name, storage device/path, Docker-removal decision, package-tracking state, the phrase `tenant volumes and databases will be destroyed`, and `leave Docker Swarm`.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
bash test/installer/test-storage.sh
bash test/installer/test-reset.sh
```

Expected: failures for missing root/fingerprint/preflight functions.

- [ ] **Step 4: Implement root-device and stable-fingerprint helpers**

In `storage.sh`, resolve root source using:

```bash
rp_storage_root_source() {
  findmnt -nro SOURCE /
}
```

Implement parent-disk resolution using `lsblk -ndo PKNAME` recursively. `rp_storage_related_to_root "$candidate"` returns failure/safety rejection when the candidate equals the root block device, is an ancestor of it, or is a child of the same disk whose destruction would affect root.

Implement `rp_storage_fingerprint` from stable udev/block metadata. The output must include at least one stable identifier from `ID_WWN`, `ID_SERIAL`, `ID_PART_ENTRY_UUID`, filesystem UUID, or PARTUUID plus device type/size. If no stable identifier is available, return non-zero. Do not accept `/dev/sdX` path alone as identity.

- [ ] **Step 5: Implement sanitized factory plan persistence**

Use root-only atomic writes under `/var/lib/resourceportal/reset-state`:

```bash
RP_RESET_STATE_DIR="${RP_RESET_STATE_DIR:-/var/lib/resourceportal/reset-state}"
RP_FACTORY_RESET_STATE="${RP_FACTORY_RESET_STATE:-$RP_RESET_STATE_DIR/factory.state}"
RP_FACTORY_RESET_PLAN="${RP_FACTORY_RESET_PLAN:-$RP_RESET_STATE_DIR/factory.plan}"
```

`rp_reset_factory_plan_write` writes only the explicit allow-listed keys, `chmod 0600`, then `mv -f`. `rp_reset_factory_plan_load` parses only those keys and rejects unknown keys rather than `source`-ing arbitrary shell.

The first successful preflight creates the plan. A resumed preflight loads the existing plan and verifies current config/device evidence matches it; it does not silently replace a prior approved target.

- [ ] **Step 6: Implement factory preflight and confirmation**

Preflight must, in this order:

1. require root;
2. load ownership manifest if present;
3. determine stack, configured storage base path, storage device/partition, and mount path from existing config or existing `factory.plan`;
4. require explicit block device;
5. canonicalize target with `readlink -f`;
6. reject system/root relationship;
7. compute stable fingerprint;
8. verify ownership/config evidence is strong enough to wipe;
9. call `rp_swarm_unrelated_resources` and fail if any result is returned;
10. calculate `docker_remove` from ownership or override;
11. write/display sanitized destructive summary;
12. enforce exact confirmation.

No stage function that mutates Docker, fstab, mounts, packages, or storage is called by preflight.

- [ ] **Step 7: Run focused/full tests**

```bash
bash test/installer/test-storage.sh
bash test/installer/test-reset.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/installer/reset.sh scripts/installer/storage.sh scripts/installer/swarm.sh test/installer/test-reset.sh test/installer/test-storage.sh
git commit -m "feat(installer): add factory reset preflight"
```

---

### Task 5: Swarm, Enrollment, UFW, fstab, Ganesha, systemd, and Runtime Cleanup

**Files:**
- Modify: `scripts/installer/reset.sh`
- Modify: `scripts/installer/swarm.sh`
- Modify: `scripts/installer/firewall.sh`
- Modify: `scripts/installer/filesystem.sh`
- Modify: `scripts/installer/nfs.sh`
- Modify: `scripts/installer/quota.sh`
- Modify: `test/installer/test-reset.sh`
- Modify: `test/installer/test-host-runtime.sh`
- Modify: `test/installer/test-nfs.sh`

**Interfaces:**
- Produces cleanup helpers: `rp_remove_fstab_mount FSTAB MOUNTPOINT`, `rp_remove_resourceportal_ufw_rules`, `rp_remove_resourceportal_ganesha_config PATH`, `rp_unmount_resourceportal_runtime`, `rp_remove_storage_ready_unit`, `rp_swarm_resourceportal_secret_name NAME`, `rp_swarm_unrelated_resources`, `rp_reset_stop_services`, `rp_reset_remove_stack`, `rp_reset_remove_swarm_resources`, `rp_reset_remove_enrollment`, `rp_reset_remove_system_config`, `rp_reset_unmount_runtime`, `rp_reset_leave_swarm`.

- [ ] **Step 1: Write failing exact-cleanup tests**

For fstab, create:

```text
UUID=system / ext4 defaults 0 1
UUID=rp /srv/resource-portal/storage xfs defaults,prjquota 0 0
server:/other /mnt/other nfs4 defaults 0 0
/srv/resource-portal/storage/volumes /mnt/resourceportal/volumes none bind 0 0
```

Call the removal helper for `/srv/resource-portal/storage` and `/mnt/resourceportal/volumes`; assert the system and `/mnt/other` lines remain byte-for-byte.

For UFW, stub `ufw status numbered` with ResourcePortal comments plus an unrelated SSH rule. Assert cleanup issues delete commands only for rules whose comments begin with the exact installer-owned `ResourcePortal-` identifiers and never invokes `ufw reset`.

For Ganesha/systemd, assert only `/etc/ganesha/resourceportal.conf`, `resourceportal-storage-ready.service`, and `/usr/local/lib/resourceportal/storage-ready-check` are targeted.

- [ ] **Step 2: Write failing Swarm classification tests**

Stub `docker service ls`, `docker secret ls`, and `docker config ls` with:

- `${stack}_api` and `${stack}_web`;
- `rp_postgres_password`;
- `rp_cookie_secret_deadbeef`;
- an unrelated service `other_stack_web`;
- unrelated secret `other_secret`.

Assert `rp_swarm_unrelated_resources` reports the unrelated names and preflight refuses. With only ResourcePortal-known names, assert it returns no output.

The known ResourcePortal classifier must accept all service/config names prefixed with `${stack}_`. The secret classifier must additionally accept:

```text
rp_postgres_password
zitadel_postgres_password
rp_encryption_key
rp_database_url
zitadel_secret_config
zitadel_init_steps
rp_first_admin_password
rp_cookie_secret_*
rp_internal_worker_token_*
rp_oidc_client_secret_*
zitadel_masterkey_*
rp_smtp_password_*
installer_swarm_worker_token_*
installer_swarm_manager_token_*
installer_enrollment_tls_cert_*
installer_enrollment_tls_key_*
```

and any exact secret reference persisted in the approved factory plan/config.

- [ ] **Step 3: Run tests and verify RED**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-host-runtime.sh
bash test/installer/test-nfs.sh
```

Expected: failures for missing cleanup/classification functions.

- [ ] **Step 4: Implement exact host-config cleanup helpers**

Implement `rp_remove_fstab_mount` with the same atomic awk pattern used by current writers:

```bash
awk -v mountpoint="$mountpoint" '$2 != mountpoint { print }' "$fstab" >"$tmp"
cat "$tmp" >"$fstab"
```

Implement UFW removal by parsing current numbered rules in descending rule-number order for ResourcePortal comments, then running `ufw --force delete "$number"`; never call `ufw reset` or change default policies.

Implement Ganesha cleanup only when the target is ownership-recorded or carries the installer header `# Managed by ResourcePortal Production Installer.`. After removal, reload/restart Ganesha only if the service exists.

Implement storage-ready unit cleanup by `systemctl disable --now resourceportal-storage-ready.service || true`, removing only the fixed owned unit/helper, then `systemctl daemon-reload`.

- [ ] **Step 5: Implement runtime/Swarm cleanup stages idempotently**

`rp_reset_stop_services` enumerates services whose `com.docker.stack.namespace` label equals the approved stack. For replicated services it issues `docker service update --replicas 0 "$service"`; already-zero/already-absent services succeed. It does not touch services outside the approved stack.

`rp_reset_remove_stack`:

```bash
docker stack rm "$stack" || true
```

then poll until no service has `com.docker.stack.namespace=$stack`; timeout returns failure.

`rp_reset_remove_swarm_resources` removes only known ResourcePortal secrets/configs after services are gone; missing resources are success.

`rp_reset_remove_enrollment` removes `${stack}-installer-enrollment`, migration/bootstrap temporary services matching the exact ResourcePortal naming conventions, and installer enrollment state files.

`rp_reset_unmount_runtime` unmounts `/mnt/resourceportal/platform`, `/mnt/resourceportal/secrets`, `/mnt/resourceportal/volumes`, then the storage mount; already-unmounted targets succeed. Remove only matching fstab entries.

`rp_reset_leave_swarm` first re-runs unrelated-resource classification. If Swarm is inactive, succeed. If this host is a manager being destroyed and no unrelated resources exist, use `docker swarm leave --force`; otherwise use normal leave where valid.

- [ ] **Step 6: Connect protected-state Swarm-secret detection from Task 3**

Replace the temporary `rp_reset_managed_swarm_secret_present` stub contract with a real implementation based on `rp_swarm_resourceportal_secret_name` and current `docker secret ls` output.

- [ ] **Step 7: Run focused/full tests**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-host-runtime.sh
bash test/installer/test-nfs.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/installer/reset.sh scripts/installer/swarm.sh scripts/installer/firewall.sh scripts/installer/filesystem.sh scripts/installer/nfs.sh scripts/installer/quota.sh test/installer/test-reset.sh test/installer/test-host-runtime.sh test/installer/test-nfs.sh
git commit -m "feat(installer): remove ResourcePortal runtime safely"
```

---

### Task 6: Docker/Package Removal, Docker Data Cleanup, and Dedicated Storage Wipe

**Files:**
- Modify: `scripts/installer/reset.sh`
- Modify: `scripts/installer/docker.sh`
- Modify: `scripts/installer/storage.sh`
- Modify: `test/installer/test-reset.sh`
- Modify: `test/installer/test-storage.sh`
- Modify: `test/installer/test-ownership.sh`

**Interfaces:**
- Produces: `rp_reset_docker_removal_authorized`, `rp_reset_remove_docker`, `rp_reset_remove_docker_data`, `rp_reset_remove_packages`, `rp_reset_storage_revalidate`, `rp_reset_wipe_storage`, `rp_reset_remove_rp_data`.
- Docker removal package set is exactly `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin` plus only installer-owned host packages returned by `rp_ownership_values package`.

- [ ] **Step 1: Write failing legacy Docker/package tests**

Cover:

```bash
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=false
assert_status 1 'legacy Docker not authorized by default' rp_reset_docker_removal_authorized
RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true
assert_status 0 'legacy override authorizes known Docker removal' rp_reset_docker_removal_authorized
```

Stub `apt-get` and assert default package removal passes only ownership-recorded packages. With override, assert the known installer package candidates plus Docker package set are eligible, but the implementation does not use unrestricted `apt-get autoremove`.

- [ ] **Step 2: Write failing storage-wipe tests**

Use command stubs to verify:

- mounted target fails before `wipefs`/`sgdisk`;
- changed fingerprint fails before destructive commands;
- system/root disk fails even when `RP_FORCE_REMOVE_UNTRACKED_PACKAGES=true`;
- partition-only ownership permits `wipefs -a /dev/sdb1` but never `sgdisk --zap-all /dev/sdb`;
- whole-disk ownership permits wiping child partition signatures followed by `sgdisk --zap-all /dev/sdb` and `wipefs -a /dev/sdb`;
- already-absent signatures are idempotent success after identity checks.

Record all attempted destructive commands to a temp file and assert exact targets.

- [ ] **Step 3: Run tests and verify RED**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-storage.sh
bash test/installer/test-ownership.sh
```

Expected: failures for missing removal/wipe functions.

- [ ] **Step 4: Implement Docker and package removal**

`rp_reset_remove_docker` must:

1. check the factory plan's `docker_remove=true` decision;
2. stop/disable `docker.service`, `docker.socket`, and `containerd.service` when present;
3. `apt-get purge -y` only the known Docker package set that is installed;
4. remove Docker apt source/key only when ownership-recorded or override is true;
5. retain/report Docker when provenance is unproven and override is false.

`rp_reset_remove_docker_data` removes `/var/lib/docker` only when the approved plan says Docker removal is authorized. It must not remove `/var/lib/containerd` unless ownership/provenance logic explicitly proves the installer-created Docker path owns it; keep the first implementation scoped to the spec-required `/var/lib/docker`.

`rp_reset_remove_packages` runs before ownership manifest deletion and purges only `rp_ownership_values package`. Under override, add only the fixed package list used by `rp_prepare_host_packages`. Do not run global autoremove.

- [ ] **Step 5: Implement immediate storage revalidation and wipe**

`rp_reset_storage_revalidate` must repeat immediately before wipe:

```text
block device exists
canonical path matches plan
stable fingerprint matches plan
not system/root related
runtime namespaces unmounted
storage mount unmounted
```

For whole-disk ownership, enumerate current child partitions from that exact disk, `wipefs -a` each child, then run `sgdisk --zap-all "$disk"` and `wipefs -a "$disk"`, followed by `udevadm settle`/`partprobe` if available.

For partition-only ownership, run `wipefs -a "$partition"` only. Never infer authorization to zap its parent disk.

- [ ] **Step 6: Implement remaining ResourcePortal data cleanup**

After storage is unmounted/wiped, remove only contract paths that are not unrelated mounts. This includes the approved plan's exact `storage_base_path` plus:

```text
/etc/resourceportal
/mnt/resourceportal
/srv/resource-portal
```

Before `rm -rf` on each directory, use `findmnt -rn -M "$path"` and refuse if it is still a separate mount not already approved/handled. `/var/lib/resourceportal/installer-state` is left for the later installer-state stage; `/var/lib/resourceportal/reset-state` is left until final cleanup.

- [ ] **Step 7: Run focused/full tests**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-storage.sh
bash test/installer/test-ownership.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/installer/reset.sh scripts/installer/docker.sh scripts/installer/storage.sh test/installer/test-reset.sh test/installer/test-storage.sh test/installer/test-ownership.sh
git commit -m "feat(installer): wipe factory reset host state"
```

---

### Task 7: Resumable Factory Lifecycle and Distinct TUI Dashboard

**Files:**
- Modify: `scripts/installer/reset.sh`
- Modify: `scripts/installer/dashboard.sh:12-45,280-305`
- Modify: `resourceportal-install.sh:47-105`
- Modify: `test/installer/test-reset.sh`
- Modify: `test/installer/test-dashboard.sh`
- Modify: `test/installer/test-tui-integration.sh`

**Interfaces:**
- Produces: `rp_factory_reset_phase_names`, `rp_reset_run_phase`, `rp_reset_factory`, complete `rp_reset` dispatch.
- Factory phase order is exactly: `preflight stop-services remove-stack remove-swarm-resources remove-enrollment remove-system-config unmount-runtime leave-swarm remove-docker remove-docker-data wipe-storage remove-rp-data remove-packages remove-installer-state final-cleanup`.

- [ ] **Step 1: Write failing phase/journal tests**

Assert exact phase output:

```bash
expected=$'preflight\nstop-services\nremove-stack\nremove-swarm-resources\nremove-enrollment\nremove-system-config\nunmount-runtime\nleave-swarm\nremove-docker\nremove-docker-data\nwipe-storage\nremove-rp-data\nremove-packages\nremove-installer-state\nfinal-cleanup'
assert_eq "$expected" "$(rp_factory_reset_phase_names)" 'factory reset phase order is stable'
```

Use a temp journal and stage functions that append calls to a marker. Force `wipe-storage` to succeed and `remove-rp-data` to fail on first run. Assert:

- journal contains stages through `wipe-storage`;
- second run skips all completed stages;
- second run starts at `remove-rp-data`;
- no install/bootstrap function is called;
- final cleanup removes journal and plan only after every required stage succeeds.

- [ ] **Step 2: Add failing dashboard tests**

In `test-dashboard.sh` assert:

```bash
assert_eq 'Factory Reset' "$(rp_dashboard_mode_label reset-factory)" 'factory reset has destructive mode label'
rp_dashboard_init reset-factory "$tmpdir/factory.state"
assert_eq pending "$(rp_dashboard_phase_status wipe-storage)" 'factory dashboard includes storage wipe phase'
```

In `test-tui-integration.sh`, simulate one failed reset stage and `retry`; assert exactly one checkpoint is written when retry succeeds.

- [ ] **Step 3: Run tests and verify RED**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-dashboard.sh
bash test/installer/test-tui-integration.sh
```

Expected: failures for missing factory lifecycle/dashboard support.

- [ ] **Step 4: Implement separate reset journal runner**

Do not reuse Primary's state file. Implement `rp_reset_run_phase` with the same retry semantics as `rp_run_phase` but use `RP_FACTORY_RESET_STATE` and reset-specific log messages. It may reuse `rp_phase_done` / `rp_phase_mark_done` because those functions are state-file generic.

`rp_reset_factory` must:

1. initialize the reset dashboard when TUI;
2. execute the exact phase list in order;
3. call `rp_reset_factory_preflight` on every process invocation before consulting destructive-stage checkpoints; if the journal does not yet contain `preflight`, mark it complete after this call succeeds; in resume mode preflight means `load factory.plan + revalidate approved target/resources` and never selects a second destructive target;
4. run `stop-services` through `final-cleanup` with `rp_reset_run_phase`, skipping previously completed destructive phases;
5. never call `rp_primary_install` or regenerate secrets.

Map stage names to the functions created in Tasks 4-6.

- [ ] **Step 5: Preserve plan/manifest until their last consumer**

`remove-installer-state` removes:

```text
/var/lib/resourceportal/installer-state/primary.state
/var/lib/resourceportal/installer-state/release.json
/var/lib/resourceportal/installer-state/secrets
/var/lib/resourceportal/installer-state/enrollment
/var/lib/resourceportal/installer-state/zitadel-bootstrap.json
/var/lib/resourceportal/installer-state/identity-bootstrap
/var/lib/resourceportal/installer-state/owned-resources
```

but only after `remove-packages` completes.

`remove-installer-state` also removes `/var/lib/resourceportal/installer-ui` after all package/provenance consumers are finished.

`final-cleanup` removes the reset log directory `/var/log/resourceportal` only after the final success summary has been emitted, then removes `factory.plan` and removes `factory.state` last. If removal of any required cleanup artifact fails, return non-zero and leave enough reset state to rerun.

- [ ] **Step 6: Add dashboard reset mode**

Add:

```bash
reset) printf 'Reset\n' ;;
reset-factory) printf 'Factory Reset\n' ;;
```

and use `rp_factory_reset_phase_names` for `reset-factory`. The rendered header must visibly say `Factory Reset`; completion text must say ResourcePortal data/storage were destroyed and list retained untracked Docker/packages when applicable.

- [ ] **Step 7: Run focused/full tests**

```bash
bash test/installer/test-reset.sh
bash test/installer/test-dashboard.sh
bash test/installer/test-tui-integration.sh
npm run test:installer
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/installer/reset.sh scripts/installer/dashboard.sh resourceportal-install.sh test/installer/test-reset.sh test/installer/test-dashboard.sh test/installer/test-tui-integration.sh
git commit -m "feat(installer): make factory reset resumable"
```

---

### Task 8: Operator Documentation and Guarded Disposable-VM E2E Harness

**Files:**
- Create: `scripts/run-installer-reset-e2e.sh`
- Modify: `docs/production-installer.md`
- Modify: `docs/superpowers/specs/2026-09-09-installer-reset-design.md:4`

**Interfaces:**
- E2E script consumes required environment variables `RP_RESET_E2E_DISPOSABLE`, `RP_RESET_E2E_STORAGE_DEVICE`, and `RP_RESET_E2E_CONFIG`; their values are validated at runtime and no storage device is auto-selected.
- The E2E script refuses to run unless the disposable-host sentinel and a non-root dedicated block device are both proven.
- It is not part of normal `npm run test:installer` because it intentionally destroys Docker/storage/host packages.

- [ ] **Step 1: Write the E2E guard first**

Create `scripts/run-installer-reset-e2e.sh` beginning with:

```bash
#!/usr/bin/env bash
set -euo pipefail

[[ "${RP_RESET_E2E_DISPOSABLE:-}" == YES ]] || {
  printf '%s\n' 'Refusing destructive reset E2E: RP_RESET_E2E_DISPOSABLE=YES is required.' >&2
  exit 2
}
[[ -n "${RP_RESET_E2E_STORAGE_DEVICE:-}" && -b "$RP_RESET_E2E_STORAGE_DEVICE" ]] || {
  printf '%s\n' 'RP_RESET_E2E_STORAGE_DEVICE must be an explicit block device.' >&2
  exit 2
}
[[ -r "${RP_RESET_E2E_CONFIG:-}" ]] || {
  printf '%s\n' 'RP_RESET_E2E_CONFIG must point to the installer config for this disposable host.' >&2
  exit 2
}
```

Source `storage.sh`, reject `rp_storage_related_to_root "$RP_RESET_E2E_STORAGE_DEVICE"`, and reject if the device is mounted anywhere except the ResourcePortal storage path declared in the test config.

- [ ] **Step 2: Implement concrete pre-reset assertions**

The disposable VM must already have been installed by the production installer. Before reset, assert:

```bash
docker info --format '{{.Swarm.LocalNodeState}}' | grep -qx active
docker service ls --format '{{.Name}}' | grep -q '^resourceportal-control-plane_'
test -r /etc/resourceportal/installer.conf
test -r /var/lib/resourceportal/installer-state/owned-resources
findmnt -rn -M /srv/resource-portal/storage >/dev/null
```

Create unrelated sentinels that must survive:

```bash
printf 'keep\n' >/tmp/resourceportal-reset-e2e-unrelated-file
sudo sh -c "printf '%s\n' '# unrelated fstab sentinel' >>/etc/fstab"
cp /var/lib/resourceportal/installer-state/owned-resources /tmp/resourceportal-reset-e2e-owned-resources.before
```

Do not create unrelated Swarm resources because preflight is intentionally required to refuse those; the unit test suite covers that refusal.

- [ ] **Step 3: Run the real non-interactive factory reset**

Execute:

```bash
sudo ./resourceportal-install.sh \
  --mode reset \
  --scope factory \
  --non-interactive \
  --confirm-factory-reset \
  --allow-destructive-storage \
  --config "$RP_RESET_E2E_CONFIG"
```

Do not pass `--force-remove-untracked-packages` on a new installer-created VM; provenance must be sufficient.

- [ ] **Step 4: Assert post-reset state**

Verify:

```bash
! test -e /etc/resourceportal
! test -e /var/lib/resourceportal/installer-state
! test -e /var/lib/resourceportal/reset-state/factory.state
! test -e /var/lib/resourceportal/reset-state/factory.plan
! findmnt -rn -M /srv/resource-portal/storage >/dev/null 2>&1
! wipefs -n "$RP_RESET_E2E_STORAGE_DEVICE" | grep -q .
test "$(cat /tmp/resourceportal-reset-e2e-unrelated-file)" = keep
grep -Fxq '# unrelated fstab sentinel' /etc/fstab
```

If Docker was installer-owned, assert `command -v docker` fails and `/var/lib/docker` is absent. Check the saved ownership copy explicitly:

```bash
while read -r type value; do
  [[ "$type" == package ]] || continue
  ! dpkg-query -W -f='${db:Status-Abbrev}\n' "$value" 2>/dev/null | grep -q '^ii '
done </tmp/resourceportal-reset-e2e-owned-resources.before
```

Because only installer-created packages are present in that manifest, every listed package must be gone.

- [ ] **Step 5: Document operator behavior**

Update `docs/production-installer.md` with:

- the three reset commands;
- exact interactive phrase;
- non-interactive required flags;
- explicit warning that factory reset destroys tenant data/databases/storage and leaves Swarm;
- legacy behavior for untracked Docker/packages;
- `--force-remove-untracked-packages` scope and limitations;
- unrelated Swarm resource refusal;
- resume behavior using the factory reset journal;
- a statement that there is no preserve-data uninstall in this feature.

Change the spec status line to:

```text
Status: DESIGN APPROVED
```

- [ ] **Step 6: Validate docs/script syntax**

```bash
bash -n scripts/run-installer-reset-e2e.sh
grep -F 'FACTORY RESET RESOURCEPORTAL' docs/production-installer.md
grep -F -- '--confirm-factory-reset' docs/production-installer.md
grep -F -- '--force-remove-untracked-packages' docs/production-installer.md
```

Expected: all succeed.

- [ ] **Step 7: Commit**

```bash
git add scripts/run-installer-reset-e2e.sh docs/production-installer.md docs/superpowers/specs/2026-09-09-installer-reset-design.md
git commit -m "docs(installer): document factory reset lifecycle"
```

---

### Task 9: Fresh Verification, Disposable E2E, and PR Readiness

**Files:**
- Verify all files changed in Tasks 1-8.
- Modify only defects found by the verification commands below.

**Interfaces:**
- Produces fresh evidence required before claiming implementation complete.

- [ ] **Step 1: Run shell syntax checks**

```bash
for file in resourceportal-install.sh scripts/installer/*.sh test/installer/*.sh scripts/run-installer-reset-e2e.sh; do
  bash -n "$file"
done
```

Expected: exit 0.

- [ ] **Step 2: Run ShellCheck with the same CI severity**

```bash
shellcheck --severity=warning -x \
  resourceportal-install.sh \
  scripts/installer/*.sh \
  packages/resourceportal-postgres/postgres-fence.sh \
  test/installer/*.sh \
  scripts/run-installer-reset-e2e.sh
```

Expected: exit 0.

- [ ] **Step 3: Run full installer test suite**

```bash
npm run test:installer
```

Expected: every installer test reports PASS and command exits 0.

- [ ] **Step 4: Run repository CI-equivalent tests affected by installer changes**

```bash
npm run build
npm run lint
npm test
```

Expected: all exit 0. If a repository-wide unrelated failure exists, record the exact failing command/output and do not claim full green.

- [ ] **Step 5: Run guarded factory-reset E2E only on a disposable VM**

On a newly provisioned supported Debian/Ubuntu VM with a dedicated non-system blank disk and a ResourcePortal installation created by the installer, run:

```bash
sudo env \
  RP_RESET_E2E_DISPOSABLE=YES \
  RP_RESET_E2E_STORAGE_DEVICE="$RP_RESET_E2E_STORAGE_DEVICE" \
  RP_RESET_E2E_CONFIG=/etc/resourceportal/installer.conf \
  ./scripts/run-installer-reset-e2e.sh
```

Before this command, the operator must export `RP_RESET_E2E_STORAGE_DEVICE` to the exact dedicated test disk on that disposable VM and verify it with `lsblk`. The script itself re-checks that it is not root/system storage. Do not run this step on `192.168.100.100`, `192.168.100.180`, a developer workstation, or a shared CI/self-hosted runner.

Expected: script exits 0 and proves ResourcePortal/Docker/owned packages/storage are gone while unrelated sentinels remain.

- [ ] **Step 6: Re-run full installer tests after any E2E-driven fixes**

```bash
npm run test:installer
```

Expected: exit 0.

- [ ] **Step 7: Review diff for secret/logging safety and scope**

```bash
git diff main...HEAD -- resourceportal-install.sh scripts/installer test/installer docs/production-installer.md scripts/run-installer-reset-e2e.sh
grep -RInE 'cat .*pat|cat .*password|echo .*token|set -x' scripts/installer/reset.sh scripts/installer/ownership.sh scripts/run-installer-reset-e2e.sh
```

Expected: no secret-value logging, no `set -x`, no global `ufw reset`, no unrestricted `apt-get autoremove`, no disk glob passed to `wipefs`/`sgdisk`.

- [ ] **Step 8: Commit any verification-only fixes, then inspect status**

If verification required code changes:

```bash
git add -A
git commit -m "fix(installer): harden factory reset verification"
```

Then:

```bash
git status --short
git log --oneline --decorate -10
```

Expected: clean working tree and the task commits visible.

- [ ] **Step 9: Push branch and open PR**

```bash
git push -u origin HEAD
```

Open a PR to `main` titled:

```text
feat(installer): add safe factory reset
```

PR body must include fresh evidence for `npm run test:installer`, ShellCheck, and the disposable-VM factory reset E2E. Do not merge until required GitHub workflows for the final head SHA are green.

---

## Requirement Coverage Matrix

- First-class `reset` mode, scopes, help, TUI prompt: Task 3.
- Safe `settings` and `installer-state` refusal semantics: Task 3.
- Ownership manifest and package provenance: Task 1.
- Docker/storage/system resource provenance: Task 2.
- Exact factory confirmation and non-interactive flags: Task 4.
- Sanitized resumable factory plan: Tasks 4 and 7.
- Unrelated Swarm refusal and RP-only Swarm cleanup: Task 5.
- RP-only UFW/fstab/Ganesha/systemd cleanup: Task 5.
- Docker/package legacy fail-safe and override: Task 6.
- System/root disk rejection, partition-only safety, fingerprint revalidation, storage wipe: Tasks 4 and 6.
- Full destructive lifecycle ordering/idempotency/journal: Task 7.
- Logging/no-secret constraints: Tasks 4-9.
- Operator docs and guarded isolated E2E: Tasks 8-9.
- No preserve-data uninstall / no global firewall reset / no global autoremove: Global Constraints, Tasks 5-8.
