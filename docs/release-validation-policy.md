# ResourcePortal release validation policy

This file and `AGENTS.md` are the durable release rule for maintainers and agents.

## Semantic versioning

- **Patch / non-milestone release**: `X.Y.N` with only **N** changing (e.g. `v0.2.65 → v0.2.66`). Default to **Fast Fix**, not full project E2E.
- **Milestone release**: major/minor changes (`X` or `Y`), or a version explicitly listed in `config/release-milestones.json`. Perform full CI, live federation, installer and real-Swarm E2E.
- To prepare a patch PR use `fastfix/vX.Y.N-short-description`; the `ResourcePortal Fast Fix` job validates the branch version against existing Git tags and rejects milestone versions.
- Do not mark a milestone as fastfix to bypass its gates. The automatic release workflow allocates a new version from the latest published release and all existing tags; it does **not** trust a commit marker alone.

## Patch validation

- In addition to mandatory full regression, run focused tests for files changed since the preceding tag (PR: diff against base branch). Selection remains deterministic and auditable in `scripts/fastfix-test-plan.mjs`.
- Every patch candidate must pass complete monorepo `npm run lint`, `npm run test`, `npm run build`, `npm run test:installer` and `npm run test:cli-release` before Merge Queue. This deliberately favors release correctness over patch CI speed: failing unrelated tests still block release.
- Every `main` push must pass the complete `ResourcePortal CI + Installer` workflow. The release pipeline checks the exact triggering SHA, fails closed on failure, skip, cancellation, missing runs or timeout, and reuses their results instead of repeating source suites. Final release artifacts are still validated separately before publication.
- **Fail closed** for unclassified paths: register the new area and its relevant tests or promote to milestone/full CI. Do not claim coverage for tests that were not executed.
- Keep changed-code static checks, compilation, database schema validation and packaging where relevant; these are release gates, not broad functional/E2E suites.
- If patch changes Site/Device VPN routing, isolation, WireGuard or firewall, **real Device VPN Swarm dataplane smoke is mandatory** (allowed destination, denied destination, handshake, no full-tunnel). Do not skip a failed test by relabeling it.
- API auth, RBAC, database, networking and installer changes require their dedicated regressions. Add a new scoped test profile for other risk domains rather than running all unrelated tests.
- Existing `test:fastfix:mcp-oauth` is retained for legacy MCP/OAuth fixes, not used as the only patch-release test for every feature.
- `[fastfix]` is a legacy patch marker and no longer suppresses full CI on `main`; the version and patch classifier determine additional focused tests.


### Published-source safety in recovery releases

A Git tag alone does not prove a release was successfully published. The
official release workflow retrieves the latest published non-prerelease
GitHub Release and validates that this source tag exists in the checkout.
It passes that source to the semantic classifier, patch test selector, and
rollback manifest assessment. If no published source can be verified, the
workflow fails closed. This prevents an unsuccessful tagged build from being
advertised as a valid rollback source for a later release. Release tags are
never rewritten.

## Mandatory automatic rollback

- A release is **blocked** before Merge Queue and independently before publication if its source-to-target rollback policy is `none` or not verified. The immediate published source version is mandatory.
- Only schema-neutral **image-only** Fast Fix releases are eligible today. Database migrations, Prisma schema changes and milestones stay blocked until a separately proven database rollback/restore method exists; this rule has no manual override.
- Both gates use `scripts/run-automatic-rollback-smoke.sh` **after building the candidate API/Web/Postgres images**. The smoke downloads the immediately preceding official release manifest and its signed provenance, starts the actual previous image digests and locally built candidate images in an isolated Docker Swarm, and injects a health-check failure into the production `rp_upgrade_apply` entry point. The automatic handler must restore previous image digests, running services, manifest, stack/config files and checkpoint. Existing installer tests cover tampering and wrong source versions.
- The gate validates this workflow under isolated CI conditions. It cannot prove survival of external data corruption, database changes outside the migration diff, hardware loss, or other disaster scenarios.

## Protected main delivery

An enforced GitHub Ruleset requires PR and Merge Queue (one PR per group), together with `Required release readiness`. Direct pushes, administrator bypass and force pushes are forbidden. Each merged main revision starts publication of an immutable-SHA release plus images, CLI and manifest. The next merge is blocked until the prior main SHA has been published. See `docs/automatic-main-releases.md`.

## Advertised supported upgrade sources in new releases

New release manifests must advertise only source versions that have independent
`real-upgrade-and-restore` certification from the exact SHA and GitHub Actions
run publishing the target. Historic Git tags alone do not establish upgrade
support. In particular, a schema-changing feature must not appear installable
from a version for which the previous database, ZITADEL event store and API
read/write recovery have not been verified. The publisher intersects eligible
ancestor versions with the signed release's per-source certificates and refuses
to publish if the immediate previous official release is not in that set.

An older deployment omitted from `supportedFromVersions` is intentionally not
offered a direct update to this target. It must upgrade through a separately
supported, certified intermediate release rather than bypass the gate.
This restriction does **not** certify issuer-global ZITADEL Actions V2 cutover:
production action target availability, safe activation and detachment/restore
remain independent hard blockers for PR #407.


## Review completion before protected Merge Queue

The protected `main` ruleset requires `Required release readiness` and
resolved review threads. The required job now also fails closed unless the
authoritative PR is **not Draft**, GitHub reports no unresolved review threads,
and the Codex review receipt is **completed on the exact current PR head SHA**
with no outstanding findings. A running, stale or absent Codex review cannot
make a merge-group commit eligible. The check runs for both `pull_request`
and `merge_group` and uses GitHub's authenticated GraphQL API. This prevents
the race where auto-merge admitted a PR to the queue while Codex was still
reviewing it. A failed gate is never waived by locally green CI or an
unverified bot comment. Never enable auto-merge before review and thread
resolution; Draft is used for ongoing security fixes.


### Review completion rechecks and events

GitHub review state is asynchronous: a Codex \`COMMENTED\` review can be
submitted after the first PR validation has completed. The same signed,
branch-protected \`Required release readiness\` workflow listens to
\`pull_request_review\` (\`submitted\`, \`edited\`, \`dismissed\`) and re-runs
the full applicable release gates plus an exact-head GraphQL review check.
After closing a review thread, request a fresh Codex review of the unchanged
SHA; its submitted review event automatically re-evaluates the required gate
without manually rerunning a workflow. A review of a changed SHA must be
requested again. GitHub does **not** expose a native Actions event for thread
resolution, and \`issue_comment\`/\`pull_request_review_comment\` workflow
checks are not eligible required checks; do not rely on those events to grant
merge permission. Pending or stale Codex *security review*, when requested,
also blocks the required check. Exact-head code/security reviews containing
any findings never satisfy the merge gate, even after threads are marked
resolved; a fresh clean review is required.

The required check can still fail closed after its bounded review wait and
rerun only once GitHub delivers a trusted review submission. Draft PRs
skip the expensive candidate and integration jobs, while the always-running
required status job still fails closed because no candidate was certified.
On Ready-for-review, and on subsequent review submissions, complete release
gates run again before the required review check can become green. Nothing bypasses
the protected Merge Queue, and reviews are never treated as approvals of
unreviewed source code.


### Automatic Codex review-state recovery

Codex often edits its existing issue-comment summary rather than submitting a
new pull-request review (including when the review has zero findings). The
default-branch `codex-review-recheck.yml` workflow listens for these trusted
GitHub issue-comment edits and performs scheduled reconciliation every 15
minutes for thread resolutions that have no native Actions event.

The dispatcher is **not a required status check**; an issue-comment workflow
runs on main, not on the PR SHA, so it could never certify a protected PR.
Instead it reads the authoritative current PR and exact-head code/security
review summaries, verifies no unresolved review threads, and checks that the
original PR workflow's candidate and all applicable pre-merge checks succeeded
and **only the final Codex review step failed**. It reads every page of
GitHub job history with the all-attempts filter and preserves the newest
result for each logical job. This retains an earlier successful candidate
when GitHub reruns only the failed review job; a later failed prerequisite
always overrides earlier success. It can then call the GitHub
`rerun-failed-jobs` API against this original release-readiness workflow on
the exact PR SHA, which executes the branch-ruleset-required check again.
No commit status or check run is forged, and no old failing code/installer job
can be upgraded to a green result through this mechanism. Draft, stale or
in-flight PRs and comments not genuinely authored by the Codex bot are ignored.

This recheck is effective only after the dispatcher is merged to the
default branch; its introduction in a draft PR cannot retroactively enable
it. The scheduled scan considers the latest 300 failed readiness runs, so
long-outstanding PRs outside that bound still require a new review activity
to trigger their recovery. The Merge Queue continues to reverify the final
status at queue-build time.


### v0.2.147 incident: certified direct v0.2.146 update

v0.2.147 was accidentally published from PR #407 with known P1 OAuth and
ZITADEL Actions V2 installer defects. It is NOT a safe mandatory intermediate
release for a still-installed v0.2.146 deployment. Subsequent fixed releases
therefore independently execute the full RP+ZITADEL database/runtime rollback
smoke with v0.2.146 as source (in addition to the immediate published source
and the older 0.2.92/0.2.93/0.2.96 fleet sources). The protected pre-merge Release Readiness independently executes the same
real two-database rollback smoke from v0.2.146 and requires exact PR SHA/run
and source ZITADEL/API recovery evidence BEFORE merge. Before publication,
v0.2.146 must have an exact-target-SHA, same-workflow-run verified restoration
certificate. Without that evidence the publisher fails closed; it may never
advertise a direct v0.2.146 upgrade via static history or manual override.
