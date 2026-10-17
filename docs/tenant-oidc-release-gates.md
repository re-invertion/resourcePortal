# Tenant Identity & SSO: release and activation gates

**Current decision: NOT CERTIFIED FOR PRODUCTION.** The candidate now performs automatic tenant OIDC activation **after** its runtime preflight, so merging to `main` and releasing it would enable the feature. The implementation must not be published or merged until full real-ZITADEL and upgrade/rollback evidence is recorded for the exact candidate SHA. The installer fails closed on missing automatic rollback eligibility.

## Required separation of stages

| Stage | Entry requirement | Allowed action | Explicitly forbidden |
|---|---|---|---|
| Source review | Unit, API, SDK, CLI, UI, static security and test catalog green | Review isolated Workspace v2 diff and code assumptions | Production activation or silent user migration |
| PR validation | Review approval, destination feature branch, protected PR / Merge Queue | CI, release readiness, federation E2E, installer/Swarm checks | Unreviewed merge, bypassed checks |
| One-click production upgrade (only after certification) | Official builds, real browser token E2E and tested rollback for source/target SHA | Automatically prepare and activate all eligible tenant OIDC with `TENANT_OIDC_AUTO_ROLLOUT=true`, `TENANT_OIDC_ACTIVATION_ALLOWED=auto` and conditional `RP_NATIVE_LOGIN_ONLY=auto`; require `/api/health/tenant-oidc` readiness | Treat API liveness or incomplete tenant grants as success |
| Tenant SSO activation | Release already certified through protected CI for exact code and images | Automatically activate after each tenant has safe native identities, issuer/PKCE/JWKS/project/grants and no legacy blockers | Activate if one tenant fails, or allow arbitrary tenant admin to force `auto` activation |
| RP native-only login cutover | No inbound provider/linked identity/policy/session; hosted ZITADEL native login and break-glass E2E certified | Resolve `RP_NATIVE_LOGIN_ONLY=auto` without user action, preserving existing accounts | Delete old identities by email match or silently retire any real external federation |

The GitHub release pipeline automatically publishes on an accepted `main` merge. There is no harmless merge or dark release when the production stack sets `TENANT_OIDC_ACTIVATION_ALLOWED=auto`. **Do not merge** until exact-SHA real E2E, rollback, browser authentication/recovery and installer gates are green.

## Automatic migration policy and actual evidence

The automatic reconciler runs in the non-root API with its existing ZITADEL management
credentials; never grant them to the privileged Swarm worker. It handles active
tenants/new tenants, detects existing projects after interrupted creation, acquires a
database migration lease and synchronizes grants. Inbound federation is left untouched
when any inbound provider, linked identity, mandatory policy or session exists.
Legacy OAuth clients are **blocked**, not silently moved between project IDs.

The isolated Workspace v2 run validated the full API regression (977 tests),
installer and CLI release suites; the new automatic rollout, runtime readiness, rollback-policy, recovery and native login
tests passed. Full tenant HTTPS ZITADEL live E2E and failure-driven image rollback
**cannot be attested locally** because this isolated workspace lacks Docker and
the required published-image test environment. The isolated live scenario in
`packages/resourceportal-api/scripts/tenant-oidc-live-e2e.ts` now requires that
both temporary tenant projects are automatically activated via `auto`, without
manual activation calls. The workflow itself has not yet been rerun on this SHA. Its GitHub CI
result, source-version schema upgrade, browser login/recovery, federation gates and
mandatory rollback evidence must all be checked on the exact proposed PR SHA.
A green unit test or SQL "expand-only" classification never substitutes for this
evidence.

## Specific acceptance evidence

1. Existing RP API, web, SDK, CLI, MCP test suites and package builds all pass. Run `npm run test:catalog` and the identity-targeted Fast Fix profile to ensure the new OIDC files are classified.
2. Real, pinned ZITADEL instance: `node packages/resourceportal-api/scripts/tenant-oidc-live-preflight.mjs` must return success with separate real test credentials and project. Never store secrets in the repository.
3. Web Authorization Code + PKCE flows and every advertised token claim must be proven using real signed tokens. Required: shared real issuer and discovery/JWKS, audience and tenant project role assertions, two-tenant denial, membership removal, browser logout, consent, refresh and secret rotation.
4. Validate native ResourcePortal browser, CLI device flow and both MCP connectors before/after deprecating inbound federation.
5. Verify upgrade from the last published release with real, previous-version PostgreSQL schema/data and existing platform-project OAuth clients. Roll forward without destructive data loss; test failure recovery for interrupted provisioning.
6. Validate a real source RP **and ZITADEL database snapshot/restore** using the exact published source and candidate Postgres/API images, the actual candidate Prisma migration and a failure injected into `rp_upgrade_apply`. A schema-changing or milestone release requires exact-SHA `databaseSnapshotVerified`, `databaseSnapshotRestored`, `restoredSourceSchema` and `zitadelDatabaseRestored` evidence, a source-version-bound signed `tested` manifest and a successful restore of both databases before prior images are redeployed. Image-only/expand-only compatibility alone cannot qualify. Missing or non-local healthy database tasks block upgrade without bypass.
**Mandatory real identity-server recovery (Codex P1):** The release smoke
uses the published manifest's immutable ZITADEL image digest, boots the actual
source identity-server and eventstore.events2 schema, then boots the candidate
ZITADEL after a real candidate Prisma migration. After injecting a deployment
failure, the installer restores both databases. The smoke MUST restart the
published source ZITADEL, confirm its OIDC discovery, eventstore schema and
pre-upgrade event count, and verify previous API reads/writes. A synthetic table
does not certify identity-server rollback. The signed release requires run- and
SHA-bound zitadelSourceRuntimeReadyAfterRollback,
zitadelSourceEventstoreVerified and
candidateZitadelRuntimeReadyBeforeRollback evidence. Any missing check must
fail closed without merge or release.

7. Require all applicable GitHub checks on the exact candidate SHA: ResourcePortal CI + Installer, Federation and browser, required Swarm gates, release readiness and Merge Queue. Examine failure/skips, don't relabel a release as Fast Fix to bypass gates.
8. Record evidence in the PR: test identity, project IDs and sanitized claims; exact issuer and image versions, result of upgrading/rolling back, CI run links and user-migration consent. **No tokens, passwords, secrets or raw PII.**

## CI classification and explicitly known limitations

`scripts/fastfix-test-plan.mjs` classifies tenant OIDC, oauth applications, native login configuration, SDK/CLI and help into the respective profiles. The `identity` profile includes tenant OIDC service and UI regression tests; changed identity files make `federation_required` true. Release-readiness still invokes the legacy incoming-federation E2E workflow. **That workflow alone cannot certify the new outbound tenant project role and claims behavior**: the separate live test matrix in `docs/tenant-oidc-e2e-certification.md` must also pass.

The current isolated Workspace v2 environment contains no Docker, PostgreSQL, test ZITADEL credentials or pinned test project and **could not** perform real ZITADEL OIDC E2E or production-like upgrade/rollback. Running the live preflight here returns a deliberate blocking exit code 2 with missing variable names. These are **open release blockers**, not implied passing tests.

## Documentation and Wiki draft

Suggested Wiki pages after the code is reviewed and approved:
- *Tenant Identity & SSO*: tenant project, shared issuer, Web/SPA/Native registration and redirect validation, role-limited user access, lifecycle/credential rotation.
- *Native ResourcePortal login*: migration preflight, account recovery, CLI/MCP compatibility, break-glass and decommission of incoming OIDC/SAML.
- *SSO operator acceptance*: real ZITADEL version test matrix, token claims/refresh/consent, image rollback gate.

The operational truth must be kept consistent with these repo documents. Do not update public Wiki to advertise unapproved features.

## Rollback

On a failed rollout, explicitly set `TENANT_OIDC_ACTIVATION_ALLOWED=false` to disable further automatic activation and, if necessary for recovery, explicitly set `RP_NATIVE_LOGIN_ONLY=false` instead of its conditional `auto` production default. Preserve the existing native RP authentication path and leave old external identity links and table rows untouched. Roll back images only by the verified official automated mechanism. Explicitly reconcile ZITADEL project and user grants after recovering any partially completed operation; out-of-band accounts or orphan grants are security incidents. Tenant login token/session TTL determines when an already-issued token becomes invalid, so a successful grant deletion is not proof of immediate JWT invalidation.
