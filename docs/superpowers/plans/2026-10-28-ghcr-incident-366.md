# GHCR incident #366 implementation and verification plan

**Goal:** Restore valid registry DNS lookups and meaningful, bounded retries for failed platform image downloads.
**Architecture:** Keep validated IP pinning and immutable release provenance; distinguish a new operator retry from a Worker reclaim using the persisted execution start time. Preserve failed updater containers as evidence.
**Tech stack:** Node.js/TypeScript, Vitest, Bash, Docker CLI.
**Spec:** https://github.com/re-invertion/resourcePortal/issues/366 and linked #362 / PR #361.

## Constraints and review focus
- No database changes, tag mutation, service restarts or production deployment in this patch task.
- Preserve SSRF/DNS rebinding protection, manifest validation, attestation and rollback gates.
- A failed updater from the current execution must not be replayed automatically.
- A Worker restart must reconnect to the same updater; a fresh explicit retry must get a distinct stable name.
- Retry transport/server failures at most three times, with a five-minute bound per pull. Authentication failures fail immediately.
- Redact signed blob URLs from pull output and durable operation errors.

## Implementation
- [x] Reproduce missing Node all:true callback shape and failed-container reuse with failing regressions.
- [x] Adapt the vetted-address fix from PR #361, retain single-address semantics.
- [x] Add stable retry names, reconnect tests and URL redaction.
- [x] Add and exercise bounded image-download retries at both supervisor and release pre-pull call sites.
- [x] Register shared installer helper changes in Fast Fix coverage.
- [ ] Complete focused profiles and full lint/test/build/installer/CLI validation; record failures explicitly.
- [ ] Publish a reviewed feature-branch PR through Workspace v2, preserving release readiness and Merge Queue.

## Incident findings and limits
The platform remained on 0.2.119 after a 0.2.120 download timeout. Retrying the same operation reread its exited updater's old logs, rather than initiating a new download; this explains repeated identical old signed URLs and does not establish Docker redirect caching. GHCR DNS and HTTPS responded during diagnosis. The application had been stopped and historical Swarm tasks were unavailable: rollout summaries show 0/1 API replicas but do not identify pull/auth/startup as the cause. This patch does not claim to repair or restart that application. Standard registry Bearer challenge support beyond the DNS fix remains a separate investigation; HTTP 401 must not be relabeled as successful authentication.

## Validation results (2026-10-28)
- API full suite: 1,284 passed, one pre-existing conditional nsenter skip; frontend: 329 passed; full `npm run test` exit 0 (prior validation).
- Full `npm run build` exit 0 and full `npm run lint` exit 0 (prior final validation).
- Re-run `npm run test:installer`: exit 0, confirmed via managed Workspace process `a27439c4-2bc7-4c75-b41b-ff1a8f4a3134` and `/tmp/rp-366-installer-final.status`.
- CLI release package test: exit 0 (`/tmp/rp-366-cli-final.log`). Release installer test: exit 0 (`/tmp/rp-366-releases-final.log`).
- Focused regression tests: 38 API, 14 target-upgrade/pull, 47 Fast Fix classification passed in previous validation.
- `npm audit --audit-level=high --json`: exit 0; 3 low, 0 moderate/high/critical findings.
- `git diff --check`: exit 0.
- Final Fast Fix profile outcome from external `rp-issue366-final` container was not available through this Workspace; the equivalent full gates above and Fast Fix classification tests are documented, but final profile should also run in CI on the pushed commit.
- Production on 0.2.119 was not modified. No application recovery, private registry credentials, complete Bearer challenge support, or Docker redirect-cache root cause was verified.

## PR #367 CI follow-up (2026-10-28)
- First GitHub PR checks failed: Fast Fix run `40777001973` and Release Readiness run `40777002259`, both on installer `test-upgrade-preflight.test.mjs` (15/50 failures). This was a stale test fixture, not a reason to bypass rollback protections: test's `none` policy was now rejected at preflight, the allowed path invoked real DB restore and Swarm capability functions, and the completed-stage test waited 300 seconds for unmocked tenant OIDC readiness.
- Corrected the installer preflight test fixture only. It now models an allowed rollback versus authorization revoked after preflight; asserts manual recovery without DB restore when revoked, a simulated DB restore and Swarm rollback when allowed, and adds an explicit preflight denial test that confirms no pull or runtime mutation. Added missing mock for tenant OIDC readiness. Identity preflight test now explicitly satisfies the earlier rollback policy gate so it tests the intended identity error.
- Local validation on this follow-up: `node --test test/installer/test-upgrade-preflight.test.mjs`: 21/21 passed; `node scripts/fastfix-test-plan.mjs --base b649ddbdb6609b52f92882f53680149f1733f7f9 --head HEAD --run`: exit 0; `npm run test:installer`: exit 0; `npm run test`: exit 0; `npm run build`: exit 0; `npm run test:cli-release`: exit 0; `npm run test:catalog`: exit 0.
- Full `npm run lint` first aborted with V8 default heap limit near 1 GiB (exit 134), not a lint diagnostic. Removed generated core dump; full `NODE_OPTIONS=--max-old-space-size=4096 npm run lint` then passed (exit 0), with no code checks suppressed.
- These local results do not substitute for required GitHub Fast Fix and Release Readiness checks on the new pushed commit. No production deployment or rollback was performed.
