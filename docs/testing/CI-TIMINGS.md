# CI timing baseline and upgrade-gate bottleneck review

The ResourcePortal release pipeline already performs signed-image upgrade/restore
certification for multiple supported source versions. Do **not** add a duplicate
upgrade simulator or remove required rollback, OIDC, installer, Swarm or security
checks to reduce elapsed time. Measure queue time, wall time and runner usage
first, then optimize scheduling/build artifact reuse without weakening gates.

## Reproduce timing measurements (read only)

Requires Node.js 22 and a GitHub token with Actions metadata read permission:

```bash
GH_TOKEN="$GH_TOKEN" node scripts/report-ci-timings.mjs \
  --repo re-invertion/resourcePortal \
  --workflows release-readiness.yml,ci.yml,release.yml \
  --limit 10
```

To capture structured results for subsequent analysis, pass `--json`.
Use `--input /path/to/samples.json` for offline replay. That file must
be a JSON array of `{ "run": { ... GitHub workflow run ... }, "jobs": [ ... GitHub jobs ... ] }`
objects. No token is required for offline replay. The script never modifies
repository state, runs Docker or accesses a production ResourcePortal.

The report provides observed wall duration (from first running job to last
completed job), queue delay when timestamps exist, sum of job durations
(runner-minutes, including parallel overlap), and longest individual jobs.
It excludes skipped jobs, and treats invalid/inverted timestamps as missing
rather than as negative elapsed time. p50/p90 use nearest-rank percentiles.
These are **per workflow** observations, not automatically an end-to-end
PR → merge queue → main → signed-release critical path: GitHub concurrency,
review wait, dependencies, caching and PR/merge-group SHAs need separate
correlation before claiming savings.

## Initial observed sample, 13 November 2026

| Run | Relevant measured job durations | Evidence |
| --- | --- | --- |
| Release Readiness (13 Nov) | candidate `12 min; federation/browser `4 min; real HTTPS OIDC `2 min | [run 43426539943](https://github.com/re-invertion/resourcePortal/actions/runs/43426539943) |
| Release publisher (13 Nov) | publish `18 min | [run 43428850906](https://github.com/re-invertion/resourcePortal/actions/runs/43428850906) |
| Release Readiness (2 Nov) | candidate `8 min; Real Swarm `18 min | [run 41495517323](https://github.com/re-invertion/resourcePortal/actions/runs/41495517323) |
| Release Readiness (6 Nov) | candidate `8 min; Real Swarm `29 min | [run 42189630636](https://github.com/re-invertion/resourcePortal/actions/runs/42189630636) |

This four-run convenience sample is not a statistically representative
distribution. Re-run the script for complete per-workflow measurements before
setting or enforcing a performance budget. The Real Swarm gate is selected by
change risk and is sometimes skipped under the existing policy; skipped gates
must not be counted as a fast execution of the test.

## Proposed next change after establishing baseline

1. Correlate corresponding PR, merge-group, main CI, publisher and source-version
   rollback proofs, without treating different SHAs as the same commit.
2. Profile candidate image builds and independent historical-source restore
   checks to identify opportunities for shared immutable digests and parallel
   jobs. Maintain **independent passing certificates for each supported source**.
3. Add a **successful-upgrade functional smoke** that checks real API-to-issuer
   reachability, token verification, tenant login, application read/write and
   worker convergence after the upgrade. Current rollback fault injection cannot
   by itself prove post-upgrade functional readiness (see [issue #437](https://github.com/re-invertion/resourcePortal/issues/437)).
4. Require a bug-reproducing test for every fixed production regression, and
   check that each test fails on the faulty code. Avoid another unconditional
   full-suite invocation when exact-SHA evidence already exists.

**Do not change** `supportedFromVersions`, required release readiness,
merge queue rules, SHA-pinned release artifacts or rollback fail-closed policy
based only on timing statistics.
