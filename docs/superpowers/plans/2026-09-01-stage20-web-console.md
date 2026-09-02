# Stage 20 Web Console Implementation Plan

**Goal:** Deliver the functional React Web Console described by Wiki Stage 20 without Stage 21 styling.

**Architecture:** A Vite React SSR/MPA Web Console uses a Node document server, a shared route parser, React server rendering and client hydration. Browser/API traffic remains same-origin; `/api` is the only API proxy boundary and uses cookie credentials plus backend CSRF. Tenant context is URL-based. Normal document navigation and server-rendered deep links replace the previous SPA history-router/fallback design.

**Tech Stack:** React, TypeScript, Vite SSR, Vitest, Testing Library, Node HTTP server, Playwright, existing Resource Portal REST API.

---

## Task 1: Create isolated web workspace and test-first browser transport

- [x] Add `packages/resourceportal-web/package.json`, TypeScript/Vite config and HTML bootstrap.
- [x] Add failing tests for cookie credentials, CSRF on unsafe methods and structured API errors.
- [x] Implement browser-safe request transport and make tests pass.
- [x] Add security regression test preventing access/refresh token persistence in browser storage.

## Task 2: SSR routes, auth bootstrap and shared functional shell

- [x] Add failing route/auth state tests, including an SSR regression proving the old `location.pathname` dependency.
- [x] Implement shared public/authenticated/tenant/platform route parsing without a global history router.
- [x] Add `entry-server.tsx`, `entry-client.tsx` and `hydrateRoot` bootstrap.
- [x] Render route-specific server HTML for direct tenant deep links and return HTTP 404 for unknown document routes.
- [x] Preserve the not-found document after authenticated client hydration instead of replacing it with tenant selection.
- [x] Implement `/auth/me`, provider discovery, login/register/recover/logout flows.
- [x] Implement tenant selector with zero/one/many tenant behavior using normal document links.
- [x] Add semantic shell, loading/empty/error/access-denied states and request/correlation diagnostics.

## Task 3: Shared forms, tables and permission-aware controls

- [x] Add component tests for form validation and permission-gated/destructive actions covered by the current functional primitives.
- [x] Implement semantic JSON/form/table/detail primitives without Stage 21 styling.
- [x] Implement one-time credential display held only in React memory.
- [x] Implement generic CRUD/action resource page with mutation confirmation and independent update/delete paths where the API contract differs.

## Task 4: Tenant management surfaces

- [x] Verify tenant route/resource-family coverage for AppGroups, SingleApps, Variables, Configs, Secrets, Volumes, Registries, Domains, CustomRootDomains and HTTP endpoints against the live API/OpenAPI contract and production Web proxy.
- [x] Exercise AppGroup list/detail/create/delete through the browser and verify runtime start/stop/restart against a real Docker Swarm; verify stack-preview/discard-draft API contracts.
- [x] Exercise deployment history, deploy and rollback through the browser against a real Docker Swarm and verify deployment detail/events contracts.
- [x] Exercise SingleApp create/delete through live federation browser E2E and start/stop/restart against a real Docker Swarm; verify runtime-config contract coverage.
- [x] Exercise Variables/Configs/Secrets create/read/delete in live browser E2E, verify attachment contracts, and assert Secret plaintext is not rendered after create/read.
- [x] Verify Volume grow/delete, Registry CRUD/validate and Domain/CustomRootDomain/endpoint contracts through the live management matrix; exercise HTTP endpoint create/delete in browser E2E.

## Task 5: Tenant administration, billing, audit and operations

- [x] Verify Memberships/Roles/Invitations/Groups/AuthPolicy/tenant IdentityProvider contracts and routes; exercise Group create/update/delete and AuthPolicy update through browser E2E.
- [x] Exercise tenant OAuthApplications and ServiceIdentities create/rotate/delete with one-time credentials held only in browser memory.
- [x] Verify Billing account/transactions/usage/top-up contracts and exercise Quota read/update through browser E2E.
- [x] Exercise Audit filtering/export through browser E2E and verify list/export API contracts.
- [x] Verify Operations list/detail/events/manual-retry contracts and production document routes.

## Task 6: Platform administration

- [x] Verify platform maintenance, SwarmCluster reconcile, RemoteLocations and StorageBackends through production routes/live API contracts; run real Swarm reconcile in CI.
- [x] Verify platform IdentityProviders, OAuthApplications and ServiceIdentities through production routes/live API contracts.
- [x] Verify platform billing price-list, voucher, payment, refund and correction contracts through the live management matrix.
- [x] Add public health/status screen backed only by public health API.

## Task 7: Monorepo, CI and production artifact integration

- [x] Update root build/lint/test integration so the web workspace participates in monorepo verification.
- [x] Refresh lockfile and update Vite/Vitest to audited versions; dependency audit reports zero high/critical findings.
- [x] Add production SSR client/server artifacts and same-origin `/api` proxy without API interception by the document renderer.
- [x] Pin the production API proxy to `RESOURCE_PORTAL_API_ORIGIN`; absolute-form browser request targets cannot replace the configured upstream host.
- [x] Add production HTTP smoke for direct deep links and non-SPA 404 behavior.
- [x] Add Stage 20 browser E2E to Live Federation and Real Docker Swarm CI environments.
- [x] Use an audited Playwright 1.62.1 transient browser harness in both browser workflows.

## Task 8: Verification and documentation

- [x] Run web unit/component/SSR tests, web lint/typecheck, client+SSR builds, dependency audit and production deep-link/404 smoke in CI.
- [x] Open PR #68 and require CI, Live Federation Integration and Real Docker Swarm Integration to be green for the exact final head before merge; final SHA/run evidence is recorded in PR/Wiki metadata rather than committed back into the branch.
- [x] Run live-federation browser E2E with real OIDC/SAML login and production Web `/api` session handling.
- [x] Run real-Swarm browser E2E for deploy/runtime/rollback and the Stage 20 management matrix against a live API/OpenAPI document.
- [x] Review the PR diff for accidental Stage 21 styling, credential persistence, secrets and duplicated backend enforcement; backend authorization remains authoritative.
- [x] Keep Stage 20 completion dependent on the final exact-head workflow gate and merge; publish the final COMPLETE status externally after those checks without moving the verified head.

## Completion gate

The implementation checklist is complete. Stage 20 is merge-ready only after PR #68 has CI, Live Federation Integration and Real Docker Swarm Integration green for the same final head SHA. The exact final SHA, workflow run numbers and merge commit belong in PR/Wiki completion evidence so recording them cannot invalidate the verified branch head.
