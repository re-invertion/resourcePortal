# ResourcePortal CI baseline and validation evidence

## Current change (Workspace v2, 9 October 2026)

| Gate | Result |
|---|---|
| `npm ci` | Passed |
| `npm run test:catalog` | Passed: 26 architecture / CI contract tests |
| `npm run test` | Passed: API 180 files / 720 assertions; Web 65 files / 290 assertions; other workspaces also passed |
| `npm run test:installer` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm run test:cli-release` | Passed |
| Create-application icon fallback targeted regression | Passed: 9 tests |

## Previous GitHub Actions evidence

Recent PR execution on 8 October 2026 (approximate wall times inclusive of runner scheduling):

| Gate | Observed duration | Conclusion |
|---|---:|---|
| Full CI | 5m 29s | Success |
| Real Docker Swarm | 14m 38s | Success |
| Identity Federation | 2m 50s | Success |
| Installer Quality | 1m 10s | Success |

A subsequent full CI push that evening failed on the Create Application Wizard image fallback assertion. API 720/720 passed, Web 289/290 passed. The assertion expected a candidate icon URL immediately after an image error; it has now been revised to await the corresponding React transition **without removing the fallback-chain assertions**. The targeted test passed locally, but the new revision must still be verified in GitHub Actions.

These observed durations are not performance guarantees, p95 statistics, coverage percentages or flaky-rate measurements. A sustained trend requires multiple representative workflow runs.

## Outstanding real-runtime validation

GitHub PR workflows (Swarm, VPN, federation, installer) provide disposable infrastructure testing; the local Workspace v2 is not an approved substitute for those real-runtime jobs. Success must be observed from GitHub before the changes are merged.

## Rules

Never record skipped or unexecuted checks as passed. Milestone release publishing is blocked until reusable system workflows complete successfully. Fast Fix push validation ensures that a skipped full-CI job does not create a missing required gate.
