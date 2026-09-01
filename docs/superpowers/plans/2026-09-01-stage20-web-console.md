# Stage 20 Web Console Implementation Plan

**Goal:** Deliver the functional React Web Console described by Wiki Stage 20 without Stage 21 styling.

**Architecture:** A Vite React SPA talks only to same-origin `/api` through a browser-safe transport using cookie credentials and backend CSRF. Tenant context is URL-based. Shared declarative CRUD/action screens cover broad management API families, while auth, AppGroups/deployments, billing/quota, audit, operations and platform infrastructure receive specialized workflows.

**Tech Stack:** React, TypeScript, Vite, Vitest, Testing Library, Playwright (browser smoke), existing Resource Portal REST API.

---

## Task 1: Create isolated web workspace and test-first browser transport

- [ ] Add `packages/resourceportal-web/package.json`, TypeScript/Vite config and HTML bootstrap.
- [ ] Add failing tests for cookie credentials, CSRF on unsafe methods and structured API errors.
- [ ] Implement browser-safe request transport and make tests pass.
- [ ] Add security regression test preventing access/refresh token persistence in browser storage.

## Task 2: Router, auth bootstrap and shared functional shell

- [ ] Add failing route/auth state tests.
- [ ] Implement public/authenticated/tenant/platform route parsing and history navigation.
- [ ] Implement `/auth/me`, provider discovery, login/register/recover/logout flows.
- [ ] Implement tenant selector with zero/one/many tenant behavior.
- [ ] Add semantic shell, loading/empty/error/access-denied states and request/correlation diagnostics.

## Task 3: Shared forms, tables and permission-aware controls

- [ ] Add component tests for field rendering, validation errors and permission-gated actions.
- [ ] Implement schema-driven form/table/detail primitives using semantic HTML only.
- [ ] Implement one-time credential display held only in React memory.
- [ ] Implement generic CRUD/action resource page with mutation confirmation.

## Task 4: Tenant management surfaces

- [ ] Add tenant routes for AppGroups, Apps, Variables, Configs, Secrets, Volumes, Registries and Domains/CustomRootDomains/HTTP endpoints.
- [ ] Implement AppGroup list/detail/create/delete, runtime start/stop/restart, stack preview and discard draft.
- [ ] Implement deployment history/detail/events/deploy/rollback.
- [ ] Implement SingleApp CRUD/runtime/resource configuration.
- [ ] Implement Variables/Configs/Secrets CRUD and attachments; never expect plaintext Secret from reads.
- [ ] Implement Volume CRUD/grow/attachments, Registry CRUD/validate and Domain/endpoint verification/assignment flows.

## Task 5: Tenant administration, billing, audit and operations

- [ ] Implement Memberships/Roles/Invitations/Groups/AuthPolicy/tenant IdentityProviders.
- [ ] Implement tenant OAuthApplications and ServiceIdentities, including create/rotate one-time credentials.
- [ ] Implement Billing account/transactions/usage/top-up-voucher surfaces and Quota read/update.
- [ ] Implement Audit filters/pagination/export.
- [ ] Implement Operations list/detail/events/manual retry.

## Task 6: Platform administration

- [ ] Implement platform maintenance, SwarmCluster reconcile, RemoteLocations and StorageBackends.
- [ ] Implement platform IdentityProviders, OAuthApplications and ServiceIdentities.
- [ ] Implement platform billing price lists, vouchers, payments, refunds and corrections.
- [ ] Add public health/status screen backed only by public health API.

## Task 7: Monorepo, CI and production artifact integration

- [ ] Update root build/lint/test scripts to include web workspace.
- [ ] Update lockfile for new web dependencies.
- [ ] Add static SPA server/Docker artifact and same-origin routing documentation without intercepting `/api`.
- [ ] Add browser E2E Stage 20 smoke and CI invocation against real API environment.

## Task 8: Verification and documentation

- [ ] Run web unit/component tests, full monorepo lint/test/build and security regression.
- [ ] Open PR and verify CI/Live Federation/Real Swarm workflows for final head.
- [ ] Review changed files/diff for accidental styling, secrets or duplicated backend enforcement.
- [ ] Update Wiki Stage 20 checklist only for items supported by verified code; mark Stage 20 COMPLETE only if 20.1–20.40 are demonstrably satisfied.
