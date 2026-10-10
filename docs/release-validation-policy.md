# ResourcePortal release validation policy

This file and `AGENTS.md` are the durable release rule for maintainers and agents.

## Semantic versioning

- **Patch / non-milestone release**: `X.Y.N` with only **N** changing (e.g. `v0.2.65 → v0.2.66`). Default to **Fast Fix**, not full project E2E.
- **Milestone release**: major/minor changes (`X` or `Y`), or a version explicitly listed in `config/release-milestones.json`. Perform full CI, live federation, installer and real-Swarm E2E.
- To prepare a patch PR use `fastfix/vX.Y.N-short-description`; the `ResourcePortal Fast Fix` job validates the branch version against existing Git tags and rejects milestone versions.
- Do not mark a milestone as fastfix to bypass its gates. The automatic main release resolves the next unused version from existing semver tags and compares against the latest **published** release; it does **not** trust a commit marker alone.

## Patch validation

- Only execute tests related to files changed since the preceding tag (PR: diff against base branch). Selection is deterministic and auditable in `scripts/fastfix-test-plan.mjs`.
- **Fail closed** for unclassified paths: register the new area and its relevant tests or promote to milestone/full CI. Do not claim coverage for tests that were not executed.
- Keep changed-code static checks, compilation, database schema validation and packaging where relevant; these are release gates, not broad functional/E2E suites.
- If patch changes Site/Device VPN routing, isolation, WireGuard or firewall, **real Device VPN Swarm dataplane smoke is mandatory** (allowed destination, denied destination, handshake, no full-tunnel). Do not skip a failed test by relabeling it.
- API auth, RBAC, database, networking and installer changes require their dedicated regressions. Add a new scoped test profile for other risk domains rather than running all unrelated tests.
- Existing `test:fastfix:mcp-oauth` is retained for legacy MCP/OAuth fixes, not used as the only patch-release test for every feature.
- `[fastfix]` in a merge commit is a legacy marker for skipping broad CI on main; version and test plan remain authoritative for publishing tagged patches.

## Main branch delivery contract

- Every approved change enters `main` exclusively via a PR and **Merge Queue**; a repository Ruleset must enforce `Required release readiness`, without administrator bypass or direct pushes. See `docs/automatic-main-releases.md`.
- Before the merge, run actual candidate image builds, CLI packaging, relevant tests, and real Swarm/federation/installer checks. Any failing or skipped required gate prevents merge.
- `release.yml` runs on each `push` to `main`, chooses a new version, serializes publication and pins it to the triggering commit SHA. Git tag and GitHub Release are created only after all publish checks succeed; they are not created manually.
- A previous unpublished `main` blocks all subsequent merges; failures require recovery and complete publication before normal queue operation resumes. No production deployment is part of this process.
