# Automatic main releases and mandatory merge gates

**Policy:** Every PR entering `main` must be releasable. A successfully merged PR starts publication without manual tags or manual workflow dispatch. This publishes GitHub Releases and registry images; it does **not** deploy to a running installation.

## Branch ruleset — REQUIRED repository administration

The workflows alone do not prevent direct pushes or bypass merges. A repository administrator **must** activate a GitHub branch ruleset for `refs/heads/main` before this change can be regarded as enforced.

Settings → Rules → Rulesets → New branch ruleset:

1. Enforcement: **Active**, target **main**; no bypass actors (including administrators), prevent deletion and force pushes.
2. Require a pull request before merging; require review-thread resolution and dismiss stale approvals when new commits arrive. Configure approvals according to team policy.
3. Require status check **Required release readiness** from GitHub Actions; require branches to be up to date.
4. **Require merge queue**. Set maximum group size to one PR (one merge → one release) and require the same **Required release readiness** check on `merge_group`.
5. Disable force pushes/direct pushes and disallow bypass. Disable direct merge paths that do not use the queue. Restrict creation, deletion and updates of `v*` tags using a separate tag ruleset to the release automation identity; ordinary contributors must not publish arbitrary releases.
6. Enable repository auto-merge only if desired; use the queue rather than individual manual merges.

Verify **with a negative test**: an administrator and a contributor attempt a direct push/merge without passing the check; both must be rejected by GitHub. Check that a queued PR does not merge while the prior published release does not point to the current main commit. Do not assume these protections exist until this has been tested.

**Access note:** The connected GitHub integration currently gets HTTP 403 from the branch-protection API. The ruleset cannot be installed through this integration and must be applied using an administrator-authenticated GitHub UI/API session.

## How validation works

- `.github/workflows/release-readiness.yml` runs for PR and Merge Queue events. It validates the release candidate, installable CLI and production images. **Patches require both changed-path Fast Fix tests and complete lint/test/build/installer/CLI validation before merge** (plus mandatory dependency audit). Explicit milestones also require all live integration suites. Real Swarm/VPN, federation/browser and installer gates are required for affected patch profiles; the final check fails if any applicable gate fails, skips or is cancelled.
- Before accepting another merge, it requires that the latest published GitHub Release tag resolves to the current `main` SHA.
- There is no exception for unpublished `main` revisions; reconcile the release backlog before enabling merges.
- `.github/workflows/release.yml` triggers on every push to `main`. Jobs are serialized, never cancelled; version selection uses the last **published** release plus all existing tags. Failed/orphan tags are not reused.
- Every `main` push runs the full `ResourcePortal CI + Installer` workflow, including `[fastfix]` merges. The release workflow checks that full CI succeeded for the **exact triggering SHA**, fails closed on failed, skipped, cancelled or missing runs, and times out if CI does not complete.
- On the immutable triggering SHA, the release workflow requires the exact-SHA full CI result and does not repeat its source tests. The pre-merge readiness gate already validated applicable live integration suites. The publication job still verifies the actual installable CLI artifact and runs real isolated rollback certification on final candidate images before publishing any artifacts. It then builds and pushes API/Web/PostgreSQL images, verifies anonymous registry access, creates the CLI package and manifest, and only then creates the GitHub tag/release. It verifies that the new tag resolves to the trigger SHA.
- `scripts/next-main-release.mjs` advances the patch component for each new main SHA. Reruns for an already completely published SHA are **verified no-ops**, preventing duplicate releases. Incomplete published assets fail closed. Major/minor numbering requires a separate explicit design. Explicit milestone versions run full gates.
- If the publication fails, **do not merge another PR**. Inspect the failed GitHub Actions run, fix the cause, rerun on the original SHA if safe, and verify release/tag/images/manifest. Do not force a release tag or mutate old assets.

## Limits and recovery

This procedure greatly reduces the risk of a merge that cannot be published, but GitHub cannot make a merge plus an external GHCR/GitHub Release publication a single atomic transaction. Network/registry outages can still leave `main` temporarily unpublished; the required next-merge gate is what contains this situation.

Full pre-merge Swarm smoke is not the same as a successful upgrade from a previously published ResourcePortal version with production-like data. That compatibility gate should be extended with a disposable previous-release-to-candidate upgrade/recovery E2E before the system is treated as fully proven. Do not claim database rollback is tested solely from Git diff.


## One-time v0.2.129 publication backlog recovery via v0.2.130

After PR #381 merged at main SHA `0ae0827bfc2a0971a4ffd37becbe0e61438b32e7`,
the official release workflow passed exact-SHA full CI and real rollback testing,
but failed immediately after pushing API `v0.2.129`. The pushed attested OCI index
is `sha256:e05c01256b9bc5c697fe751155503cffef2ade5623d266df0e41064cd1d3e982`.
The Web/PostgreSQL `v0.2.129` tags and signed GitHub Release do not exist.
The original publish script cannot safely be rerun because it unconditionally
pushes the API tag before checking the registry digest.

With explicit owner authorization, PR #382 carries a **single-use, SHA- and
file-tree-scoped** recovery. Pre-merge readiness requires the published source
`v0.2.128` at `34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0`, precisely the
unpublished main SHA above, only the reviewed PR #382 files, pinned image-publisher
and audit blobs, and a live read-only cryptographic GHCR manifest audit.
The version allocator independently rechecks the same exact tree and chooses
`v0.2.130`, never `v0.2.129`, on both PR/merge-group and post-merge main.
The recovery never rewrites or reuses `v0.2.129`. A second failed execution of the original release workflow on 2026-11-02 08:22 UTC had already changed its mutable API tag to OCI index `sha256:6747f5d34930c37f99a261dfd8ac323a1a0e2eab72f70debe85b70c5a6d4e49b`; both this digest and the original `sha256:e05c01256b9bc5c697fe751155503cffef2ade5623d266df0e41064cd1d3e982` are pinned and independently verified by the read-only audit. Any further unknown tag movement blocks recovery.

This exception does **not** waive dependency audit, full lint/test/build,
installer/CLI validation, merge queue, exact-main-SHA post-merge CI, real
rollback/restore from `v0.2.128`, image digest verification or signed GitHub
OIDC release provenance. All those gates must pass for the new `v0.2.130`
release. Any other source/tag/tree or a pre-existing `v0.2.130` Git tag
fails closed. Once `v0.2.130` is officially published, the exception is
automatically inert because the published source tag will no longer be
`v0.2.128`. This operation does not deploy a running RP installation.


## One-time v0.2.131 repair for Docker 29 OCI index image identity

PR #382 successfully passed protected merge queue and exact-main-SHA CI at
`98f9e94b2b4bcf55cbf791dc38be4a4a6028cb26`, but the post-merge
Installer-Gated Release run #41429203520 failed **after** publishing API
`v0.2.130` (OCI index
`sha256:d3129b935abe2d1a0ecd0b429f0d497eed61899e0587fa604096585ef1fbf80d`).
Docker 29's containerd image store returned the *OCI index* digest for the
rollback-tested image's `.Id`. The previous publisher assumed it always
returned the runnable manifest's *config* digest
`sha256:6a34ad2fdcc8301d4f83734575be30e184184277d5f8bd4f876c0adeb6215a59`.
Those are different immutable descriptors of the same locally tested image.
The child manifest is
`sha256:90b9f6f317d0d33295a02393993aacadbfccd862907799f4a3b81ba140319392`;
BuildKit attestation is
`sha256:272d09c4d34ed3611e525abef8b2d9c42554e0c4d231195191d419a49ac799d3`.

The repaired publisher verifies all allowed OCI descriptors and accepts the
tested local identity only when it exactly matches either the verified index
digest or the verified runnable-image config digest. All other mismatches
fail closed; no rebuild occurs after the real rollback gate.

Because `v0.2.130` was partially pushed and no official signed release was
created, do **not** rerun the old SHA or rewrite its API tag. A second
strict one-time exception requires previous official `v0.2.128` at SHA
`34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0`, precisely unpublished
main `98f9e94b2b4bcf55cbf791dc38be4a4a6028cb26`, a closed set of
approved PR file paths, pinned publisher/audit blob SHA-1, and a read-only
cryptographic audit of the original `v0.2.130` OCI index and absent
Web/PostgreSQL tags. It allocates only fresh `v0.2.131` in pre-merge and
post-merge signing; neither `v0.2.129` nor `v0.2.130` is rewritten.
Dependency audit, full lint/test/build, installer/CLI, real rollback,
scope-required Swarm, merge queue, exact-SHA full main CI and signed OIDC
provenance are unmodified and mandatory. This is publication only: no
production deployment.
