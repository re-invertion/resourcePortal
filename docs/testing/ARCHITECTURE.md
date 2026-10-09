# ResourcePortal Test Architecture v2

## Levels
- unit: isolated pure logic and service tests (Vitest).
- component: React behavior with Testing Library and jsdom.
- contract: installer, API, CLI and interface assertions.
- integration: adjacent subsystems with disposable local dependencies.
- system: real Docker Swarm, XFS, NFS and VPN dataplane.
- e2e: Chromium/Playwright workflows with real service connections.
- security: authorization, tenant isolation and secrets (cross-cutting).
- upgrade: migrations, rollback policies and compatibility.

## Migration invariants
Existing tests retain their original paths until their owners and coverage are confirmed. The 275-file baseline remains immutable during the first migration. Missing tests cause catalog validation failures. All infrastructure-based tests must clean up resources even on failure.

## Commands
- npm run test:catalog — inventory validation
- npm run test — all workspaces
- npm run test:installer — installer regression
- npm run test:cli-release — packaged CLI checks

## Remaining gaps
The file inventory does not establish line or branch coverage. Existing level assignments use folder heuristics and must be reviewed manually before enforcing finer-grained suites. CI durations and flaky history still need measurement.
