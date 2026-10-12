# ResourcePortal agent rules

- Preserve existing worktrees and changes. Follow approved Workspace v2 tasks for implementation.
- Release strategy: **a change only to the third semver component (`X.Y.N`) is a non-milestone patch**. In addition to focused Fast Fix tests, the complete monorepo lint/test/build/installer/CLI gates must pass before Merge Queue. Every `main` push, including a Fast Fix merge, runs full CI. Release publishing waits for full CI success on the exact main SHA and reruns the full patch test and installer suites. Broad Federation/Swarm E2E remains scope- or milestone-dependent.
- Use `fastfix/vX.Y.N-...` branch for patch PRs and `scripts/fastfix-test-plan.mjs` for changed-path test selection. New paths without a registered profile fail closed. Never hide failures or silently skip security tests.
- For networking/VPN patches, run actual WireGuard/Swarm dataplane security smoke even in Fast Fix. Use the standard full suite for milestone releases.
- See `docs/release-validation-policy.md` for classification, workflows, tagging and exceptions.

- Main delivery: require approved PR, protected GitHub Ruleset and Merge Queue with `Required release readiness` (no bypass). Every main merge automatically builds and publishes exactly one SHA-pinned GitHub Release after all gates; no manual tag/dispatch. Do not merge until the previous main SHA is published. See `docs/automatic-main-releases.md`.
