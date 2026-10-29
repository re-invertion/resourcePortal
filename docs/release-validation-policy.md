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
