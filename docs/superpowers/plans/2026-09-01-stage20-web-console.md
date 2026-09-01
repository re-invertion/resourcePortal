# Stage 20 Web Console Implementation Plan

**Goal:** Deliver the functional React Web Console described by Wiki Stage 20 without Stage 21 styling.

**Architecture:** A Vite React SSR/MPA Web Console uses a Node document server, a shared route parser, React server rendering and client hydration. Browser/API traffic remains same-origin; `/api` is the only API proxy boundary and uses cookie credentials plus backend CSRF. Tenant context is URL-based. Normal document navigation and server-rendered deep links replace the previous SPA history-router/fallback design.

**Tech Stack:** React, TypeScript, Vite SSR, Vitest, Testing Library, Node HTTP server, Playwright (browser smoke), existing Resource Portal REST API.

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
- [x] Implement `/auth/me`, provider discovery, login/register/recover/logout flows.
- [x] Implement tenant selector with zero/one/many tenant behavior using normal document links.
- [x] Add semantic shell, loading/empty/error/access-denied states and request/correlation diagnostics.

## Task 3: Shared forms, tables and permission-aware controls

- [x] Add component tests for form validation and permission-gated/destructive actions covered by the current functional primitives.
- [x] Implement semantic JSON/form/table/detail primitives without Stage 21 styling.
- [x] Implement one-time credential display held only in React memory.
- [x] Implement generic CRUD/action resource page with mutation confirmation.

## Task 4: Tenant management surfaces

- [ ] Finish real-API verification for tenant routes covering AppGroups, Apps, Variables, Configs, Secrets, Volumes, Registries and Domains/CustomRootDomains/HTTP endpoints.
- [ ] Finish real-API verification for AppGroup list/detail/create/delete, runtime start/stop/restart, stack preview and discard draft.
- [ ] Finish real-API verification for deployment history/detail/events/deploy/rollback.
- [ ] Finish real-API verification for SingleApp CRUD/runtime/resource configuration.
- [ ] Finish real-API verification for Variables/Configs/Secrets CRUD and attachments; never expect plaintext Secret from reads.
- [ ] Finish real-API verification for Volume CRUD/grow/attachments, Registry CRUD/validate and Domain/endpoint verification/assignment flows.

## Task 5: Tenant administration, billing, audit and operations

- [ ] Finish real-API verification for Memberships/Roles/Invitations/Groups/AuthPolicy/tenant IdentityProviders.
- [ ] Finish real-API verification for tenant OAuthApplications and ServiceIdentities, including create/rotate one-time credentials.
- [ ] Finish real-API verification for Billing account/transactions/usage/top-up-voucher surfaces and Quota read/update.
- [ ] Finish real-API verification for Audit filters/pagination/export.
- [ ] Finish real-API verification for Operations list/detail/events/manual retry.

## Task 6: Platform administration

- [ ] Finish real-API verification for platform maintenance, SwarmCluster reconcile, RemoteLocations and StorageBackends.
- [ ] Finish real-API verification for platform IdentityProviders, OAuthApplications and ServiceIdentities.
- [ ] Finish real-API verification for platform billing price lists, vouchers, payments, refunds and corrections.
- [x] Add public health/status screen backed only by public health API.

## Task 7: Monorepo, CI and production artifact integration

- [x] Update root build/lint/test integration so the web workspace participates in monorepo verification.
- [x] Refresh lockfile and update Vite/Vitest to audited versions; Stage 20 Dev reports zero high/critical audit findings.
- [x] Add production SSR client/server artifacts and same-origin `/api` proxy without API interception by the document renderer.
- [x] Add Stage 20 Dev production HTTP smoke for direct deep link and non-SPA 404 behavior.
- [ ] Add browser E2E Stage 20 smoke and CI invocation against the real API environment.

## Task 8: Verification and documentation

- [x] Run web unit/component/SSR tests, web lint/typecheck, client+SSR builds, dependency audit and production deep-link smoke on Stage 20 Dev.
- [ ] Open the implementation PR and verify CI/Live Federation/Real Swarm workflows for its final head.
- [ ] Run the full browser E2E flow against a real API environment.
- [ ] Review the final PR diff for accidental styling, secrets or duplicated backend enforcement.
- [ ] Update Wiki Stage 20 checklist only for items supported by verified code; mark Stage 20 COMPLETE only if 20.1–20.40 are demonstrably satisfied.
