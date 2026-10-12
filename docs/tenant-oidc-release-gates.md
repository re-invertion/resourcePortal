# Tenant Identity & SSO: release and activation gates

**Current decision: NOT CERTIFIED FOR PRODUCTION.** The implementation can be reviewed as dark-release code, but feature activation and removal of inbound RP federation **must remain blocked** until an operator records full real-ZITADEL and upgrade/rollback evidence.

## Required separation of stages

| Stage | Entry requirement | Allowed action | Explicitly forbidden |
|---|---|---|---|
| Source review | Unit, API, SDK, CLI, UI, static security and test catalog green | Review isolated Workspace v2 diff and code assumptions | Production activation or silent user migration |
| PR validation | Review approval, destination feature branch, protected PR / Merge Queue | CI, release readiness, federation E2E, installer/Swarm checks | Unreviewed merge, bypassed checks |
| Dark release (only if approved) | Official image builds, verified rollback artifact and disabled feature flags | Publish candidate with `TENANT_OIDC_ACTIVATION_ALLOWED=false`, `RP_NATIVE_LOGIN_ONLY=false` | Advertise tenant IdP production support |
| Tenant SSO activation | Live multi-tenant OIDC claims/roles/token and revocation E2E, auditable operator certification | Enable gated activation for verified tenants | Enable after only Prisma/unit/mocked-provider tests |
| RP native-only login cutover | Native sign-in and account recovery verified for **every affected user**, hosted ZITADEL upstream policy updated, session cleanup and break-glass tested | Change `RP_NATIVE_LOGIN_ONLY=true` with rollback window | Delete old identities by email match or lock out tenants |

The GitHub release pipeline automatically publishes a release on an accepted `main` merge; there is no harmless merge. Thus **do not merge** this candidate until the release owner decides dark-release publication is acceptable and real E2E requirements are enforced.

## Specific acceptance evidence

1. Existing RP API, web, SDK, CLI, MCP test suites and package builds all pass. Run `npm run test:catalog` and the identity-targeted Fast Fix profile to ensure the new OIDC files are classified.
2. Real, pinned ZITADEL instance: `node packages/resourceportal-api/scripts/tenant-oidc-live-preflight.mjs` must return success with separate real test credentials and project. Never store secrets in the repository.
3. Web Authorization Code + PKCE flows and every advertised token claim must be proven using real signed tokens. Required: shared real issuer and discovery/JWKS, audience and tenant project role assertions, two-tenant denial, membership removal, browser logout, consent, refresh and secret rotation.
4. Validate native ResourcePortal browser, CLI device flow and both MCP connectors before/after deprecating inbound federation.
5. Verify upgrade from the last published release with real, previous-version PostgreSQL schema/data and existing platform-project OAuth clients. Roll forward without destructive data loss; test failure recovery for interrupted provisioning.
6. Validate automatic image-only rollback contract **using the release manifest**. A feature that cannot roll back automatically must fail closed at installation/release readiness. Do not claim reversible database migrations are automatically safe unless separately proven.
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

On a failed rollout, keep both flags **false**, return to existing platform-native RP authentication, and leave the old external IdP links/identity table rows untouched. Roll back images only by the verified official automated mechanism. Explicitly reconcile ZITADEL project and user grants after recovering any partially completed operation; out-of-band accounts or orphan grants are security incidents. Tenant login token/session TTL determines when an already-issued token becomes invalid, so a successful grant deletion is not proof of immediate JWT invalidation.
