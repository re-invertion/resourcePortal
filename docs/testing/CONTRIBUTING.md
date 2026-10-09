# ResourcePortal testing — contributor guide

## Ground rules

Every product change must have a deterministic regression test. Prefer unit/component checks adjacent to the implementation and a contract test for user-visible/API behavior. Docker, WireGuard and identity federation assertions must run against real ephemeral services when functionality depends on kernel/network/runtime behavior.

**Do not weaken a failing assertion or delete a baseline test merely to make CI green.** In a deliberate refactor, record the old and replacement paths in `config/test-migrations.json`, then verify equal behavior.

## Commands

```sh
npm ci
npm run test:catalog
npm run test:suites
npm run test:domain -- --domain networking
npm run test:domain -- --domain networking --run
npm run test
npm run test:installer
npm run test:cli-release
npm run lint
npm run build
```

`test:domain` without `--run` prints the test execution plan; it never silently reports an empty match as success. It accepts `--level` as an additional filter. Production/system suites are intentionally in GitHub Actions — do not run destructive system E2E on production nodes. Check `config/test-suites.json` for their environment and workflow name.

## Adding a new feature

1. Add tests as `*.spec.ts`/`*.test.tsx` alongside the relevant API/Web module or a `test-*.sh` installer contract.
2. Run `npm run test:catalog`. The catalog automatically inventories new files and their domains. Add an explicit migration mapping when replacing an old file.
3. If the feature introduces a new top-level area, add a domain classification to `scripts/test-catalog.mjs` and Fast Fix coverage to `scripts/fastfix-test-plan.mjs`.
4. Rebuild the matrix: `node scripts/test-matrix.mjs --write`. Commit the matrix change alongside the tests.
5. Check a representative Fast Fix path selection with `node scripts/fastfix-test-plan.mjs --base ... --head ...`.
6. For runtime-dependent changes, verify the dedicated disposable environment workflow is green.

## CI gates

| Event | Validation |
|---|---|
| Normal PR to main | CI, installer, federation, real Swarm |
| Fast Fix PR | Changed-scope regression, lint/build, VPN dataplane when changed |
| Merged Fast Fix push marked `[fastfix]` | Changed-scope regression on main (not a missing gate) |
| Normal push to main | Full CI plus real infrastructure |
| Patch tag | Scope validation against previous release tag, CLI package and image checks |
| Milestone tag | Full static/unit/build plus installer, federation and real Swarm before publish |

Any newly introduced API/Web source path without an explicit classifier **fails closed**. Register a reviewed profile that includes all required unit, integration and real-runtime smoke gates before using Fast Fix. A full workspace unit-test fallback is not a substitute for VPN dataplane or other system tests. Root-level workflow and test infrastructure files trigger control-plane regression.

## Test quality checklist

- Covers success and denial/error paths.
- No dependency on shared production data or fixed external IP addresses.
- Timeouts explicit, ports isolated, resources cleaned in `finally`/`always()`.
- Tests assert observable behavior, not just existence of a function.
- New database migration checks upgrade compatibility; rollback eligibility must respect release manifest policy.
- Security assertions cover tenant isolation, permissions and secret access where relevant.
- No `skip`, `only`, `continue-on-error` or unconditional exit zero in required checks.

## Reporting

`docs/testing/TEST_MATRIX.md` is a generated inventory of test files. It is not statement/branch coverage. A green file inventory check cannot substitute for a passing execution run. CI reports must distinguish passed, failed, skipped and environment-unavailable.

This refactor preserves the 275 original tracked test files and recognizes new architecture tests. It does not claim coverage completeness; further per-domain test quality assessment is required.
