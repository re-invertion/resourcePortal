# RP test baseline inventory

This document records the existing test files at the start of Test Architecture v2. The machine-readable inventory lives in `baseline-inventory.json`.

This is a file inventory, **not** number of individual test cases, successful executions or a coverage percentage. Files were selected by filename patterns `.spec.`, `.test.` and `test-*.sh`.

| Area | Files |
|---|---:|
| `packages/resourceportal-api` | 180 |
| `packages/resourceportal-cli` | 3 |
| `packages/resourceportal-help` | 1 |
| `packages/resourceportal-sdk` | 1 |
| `packages/resourceportal-web` | 65 |
| `scripts` | 2 |
| `test/cli` | 1 |
| `test/installer` | 22 |
| **Total** | **275** |

## Migration invariants

- Every baseline test must remain executable or have an explicit replacement with equivalent assertions.
- CI must not silently skip unfamiliar changed files.
- Unit/component suites remain deterministic without external networks.
- Integration suites own their temporary data and clean up after each run.
- System tests must use actual infrastructure (Swarm, XFS/NFS, VPN, federation) when asserting runtime behavior.
- Report failed, skipped and not-run checks distinctly; no false-success statuses.
- Versioned release gates must be evaluated independently of GitHub PR status.

## Known risks to investigate

- Stage-numbered filenames mix historical implementation milestones with domains.
- A test filename count does not indicate quality or complete domain coverage.
- Existing fastfix profiles use path classifiers and require explicit maintenance when files move.
- Shell installer tests overlap between multiple workflow jobs.
- Individual workflow runtime and flaky-test baselines must be measured from CI history.
