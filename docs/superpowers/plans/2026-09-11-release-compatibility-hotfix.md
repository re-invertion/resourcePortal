# Release Compatibility Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make patch releases advertise all earlier stable releases from the same `major.minor` line as valid upgrade sources, then publish a new release and upgrade production through the normal compatibility gate.

**Architecture:** Keep compatibility metadata in the existing GitHub Release manifest. The Release workflow will use full git history, derive compatible source versions from stable ancestor tags in the target patch line, and inject that JSON array into the manifest. A first release in a new line fails closed for cross-line upgrades by falling back only to its own version; cross-minor compatibility remains an explicit future decision.

**Tech Stack:** GitHub Actions, Bash, git tags, jq, existing ResourcePortal production installer.

**Spec:** Existing Production Installer release compatibility contract in `docs/production-installer.md` and `scripts/installer/releases.sh`.

## Global Constraints

- Do not mutate or retag `v0.1.2`.
- Do not bypass `rp_release_compatible` on production.
- Patch release `v0.1.3` must support upgrade from installed `0.1.1`.
- Only stable ancestor tags in the same `major.minor` line are inferred automatically.
- New `major.minor` lines must not silently become compatible with older lines.
- Production state is persisted only after the installer health check succeeds.

---

### Task 1: Release manifest compatibility generation

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `test/installer/test-releases.sh`

**Interfaces:**
- Consumes: validated semantic `VERSION`, repository tags reachable from release HEAD.
- Produces: `.migrations.supportedFromVersions` JSON array in `resourceportal-release-manifest.json`.

- [ ] Add regression assertions proving the workflow no longer hardcodes only `0.1.0`, checks out full history, derives same-series ancestor tags, and injects the derived JSON into the manifest.
- [ ] Run `bash test/installer/test-releases.sh` and verify the new assertions fail for the current workflow.
- [ ] Update `release.yml` minimally: `fetch-depth: 0`, compute prior same-series stable versions using `git tag --merged HEAD`, use target version only as the no-prior-tag fallback, pass the JSON array to `jq` with `--argjson`.
- [ ] Re-run the release tests and `git diff --check` until green.
- [ ] Commit the hotfix and plan.

### Task 2: Repository verification and merge

**Files:** no additional production files expected.

**Interfaces:**
- Consumes: Task 1 branch.
- Produces: reviewed/green merge on `main`.

- [ ] Run installer release tests plus the repository installer test suite.
- [ ] Push branch and open a PR.
- [ ] Require CI, Codespaces Preview Smoke, Live Federation Integration, and Real Docker Swarm Integration to complete successfully for the final head.
- [ ] Merge only after all required checks are green.

### Task 3: Publish safe patch release

**Files:** release artifacts only.

**Interfaces:**
- Consumes: merged `main` commit.
- Produces: immutable `v0.1.3` images and release manifest.

- [ ] Tag merged `main` as `v0.1.3` and push the tag.
- [ ] Verify the Release workflow succeeds.
- [ ] Download/inspect the `v0.1.3` manifest and assert `0.1.1` is present in `migrations.supportedFromVersions`.
- [ ] Verify all referenced images are immutable digests.

### Task 4: Production upgrade and verification

**Files:** production runtime/state only; no manual DB edits.

**Interfaces:**
- Consumes: `v0.1.3` manifest and normal `resourceportal-install.sh --mode upgrade` flow.
- Produces: healthy production at `0.1.3`.

- [ ] Confirm production reports installed `0.1.1` and is healthy before upgrade.
- [ ] Run the supported non-interactive upgrade to `0.1.3` using the existing installer configuration.
- [ ] Verify installer persisted `0.1.3` only after successful HTTPS health validation.
- [ ] Verify Web/API public health, Swarm services, nodes, OIDC login surface, and RBAC seed state.
- [ ] Update Wiki release/installer status with the final merge, release, and production verification facts.
