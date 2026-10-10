# ResourcePortal agent rules

- Preserve existing worktrees and changes. Follow approved Workspace v2 tasks for implementation.
- Release strategy: **the third semver component only (`X.Y.N`) is a non-milestone patch and uses targeted Fast Fix validation**. Full suites, whole-platform Federation/Swarm and broad browser E2E belong to `X/Y` milestone releases or versions explicitly in `config/release-milestones.json`.
- Use `fastfix/vX.Y.N-...` branch for patch PRs and `scripts/fastfix-test-plan.mjs` for changed-path test selection. New paths without a registered profile fail closed. Never hide failures or silently skip security tests.
- For networking/VPN patches, run actual WireGuard/Swarm dataplane security smoke even in Fast Fix. Use the standard full suite for milestone releases.
- See `docs/release-validation-policy.md` for classification, workflows, tagging and exceptions.

- Main delivery: require approved PR, protected GitHub Ruleset and Merge Queue with `Required release readiness` (no bypass). Every main merge automatically builds and publishes exactly one SHA-pinned GitHub Release after all gates; no manual tag/dispatch. Do not merge until the previous main SHA is published. See `docs/automatic-main-releases.md`.
