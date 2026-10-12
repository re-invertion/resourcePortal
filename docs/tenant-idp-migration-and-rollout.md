# Tenant OIDC rollout / recovery contract

## Phase A: expand (this migration)
- Add TenantOidcProvider and TenantOidcGrant tables, plus nullable OAuthApplication.zitadelProjectId. Existing providers, sessions, UserIdentity records, TenantAuthPolicy and OAuthApplication clients are untouched.
- New provider defaults: enabled=false, status=Pending; no issuer is advertised until actual project and RBAC provisioning succeeds.
- Existing OAuthApplication rows have zitadelProjectId=NULL and stay marked as legacy shared-project applications; never label them as tenant-isolated without migration.
- DB creation and deletion can cascade tenant-owned provider/grants only when deleting the Tenant itself. Do not remove the tenant's primary identity data during rollout.

## Phase B: provision and reconcile (feature gated)
- Create a dedicated ZITADEL project for every tenant. Enable projectRoleCheck and require a role assignment for each active membership; reconcile grants from RP to ZITADEL before publishing clients.
- Determine the *actual* issuer via OIDC discovery and verify signatures with its JWKS; ZITADEL has one shared issuer in this design.
- Keep issuer-side role checks fail closed. Do not issue client credentials, authorization URLs or claim support before a verified grant sync.
- Revoke grants on tenant membership suspension/deletion, user suspension, tenant suspension, and tenant provider disable. Do not rely on long-lived self-contained access-token revocation; document token TTL and API-side checks. Disallow refresh after revocation.
- Record all external resource IDs and reconcile idempotently. Never auto-grant users merely by email matching.

## Phase C: native-only RP login
- Identify all UserIdentity records with non-null identityProviderId and users with no verified ZITADEL native sign-in. Provide re-enrollment, account recovery, MFA, and break-glass for platform admins before disabling inbound OIDC/SAML.
- During upgrade, warn and fail closed on unresolved native access; disable incoming IdPs in both RP API/UI and ZITADEL login policy only after migration is complete.
- Legacy inbound rows may be archived/audited, not silently deleted. Do not try to roll back destructive changes to external identity graphs.

## Release gate
- Cross-tenant end-to-end tests with multiple users and projects, scoped claims, discovery/JWKS, code+PKCE, role grant removal, revoke/refresh, complete regression of RP BFF+CLI+MCP, migration from last release, and rollback contract.
- If running tests against real ZITADEL is unavailable, keep tenant IdP disabled and do not ship as production-ready.
