# Automatic main releases and mandatory merge gates

**Policy:** Every PR entering \`main\` must be releasable. A successfully merged PR starts publication without manual tags or manual workflow dispatch. This publishes GitHub Releases and registry images; it does **not** deploy to a running installation.

## Branch ruleset — REQUIRED repository administration

The workflows alone do not prevent direct pushes or bypass merges. A repository administrator **must** activate a GitHub branch ruleset for \`refs/heads/main\` before this change can be regarded as enforced.

Settings → Rules → Rulesets → New branch ruleset:

1. Enforcement: **Active**, target **main**; no bypass actors (including administrators), prevent deletion and force pushes.
2. Require a pull request before merging; require review-thread resolution and dismiss stale approvals when new commits arrive. Configure approvals according to team policy.
3. Require status check **Required release readiness** from GitHub Actions; require branches to be up to date.
4. **Require merge queue**. Set maximum group size to one PR (one merge → one release) and require the same **Required release readiness** check on \`merge_group\`.
5. Disable force pushes/direct pushes and disallow bypass. Disable direct merge paths that do not use the queue. Restrict creation, deletion and updates of \`v*\` tags using a separate tag ruleset to the release automation identity; ordinary contributors must not publish arbitrary releases.
6. Enable repository auto-merge only if desired; use the queue rather than individual manual merges.

Verify **with a negative test**: an administrator and a contributor attempt a direct push/merge without passing the check; both must be rejected by GitHub. Check that a queued PR does not merge while the prior published release does not point to the current main commit. Do not assume these protections exist until this has been tested.

**Access note:** The connected GitHub integration currently gets HTTP 403 from the branch-protection API. The ruleset cannot be installed through this integration and must be applied using an administrator-authenticated GitHub UI/API session.

## How validation works

- \`.github/workflows/release-readiness.yml\` runs for both PR and Merge Queue events. The required final check fails if **any** of the build, complete tests, CLI packaging, real Swarm, federation/browser, or installer jobs fail/skip/cancel.
- Before accepting another merge, it requires that the latest published GitHub Release tag resolves to the current \`main\` SHA.
- Exactly one historical bootstrap exception permits the currently unpublished \`main\` SHA \`776e4f9e7244049c11ac69fd1a6e7d6ea4cead48\` when the latest release is \`v0.2.75\`. This is not a generic bypass.
- \`.github/workflows/release.yml\` triggers on every push to \`main\`. Jobs are serialized, never cancelled; version selection uses the last **published** release plus all existing tags. Failed/orphan tags are not reused.
- On the immutable triggering SHA, it reruns release checks, builds and pushes API/Web/PostgreSQL images, verifies anonymous registry access, creates the CLI package and manifest, and only then creates the GitHub tag/release. It verifies that the new tag resolves to the trigger SHA.
- \`scripts/next-main-release.mjs\` advances the patch component for each merge. Major/minor release numbering requires a separate explicit design. Versions present in \`config/release-milestones.json\` still run full milestone gates.
- If the publication fails, **do not merge another PR**. Inspect the failed GitHub Actions run, fix the cause, rerun on the original SHA if safe, and verify release/tag/images/manifest. Do not force a release tag or mutate old assets.

## Limits and recovery

This procedure greatly reduces the risk of a merge that cannot be published, but GitHub cannot make a merge plus an external GHCR/GitHub Release publication a single atomic transaction. Network/registry outages can still leave \`main\` temporarily unpublished; the required next-merge gate is what contains this situation.

Full pre-merge Swarm smoke is not the same as a successful upgrade from a previously published ResourcePortal version with production-like data. That compatibility gate should be extended with a disposable previous-release-to-candidate upgrade/recovery E2E before the system is treated as fully proven. Do not claim database rollback is tested solely from Git diff.
