# ADR (draft): RP native login and tenant outbound OIDC

Status: **proposed / validation pending**. Baseline main 0801aacf3d58f8a5732bad25a84e93e94f79f559.

## Context
The platform ZITADEL organization and project are shared by all RP tenant OAuthApplications. Their RP database tenantId is insufficient on its own to enforce tenant-scoped identity issuance. Meanwhile incoming Platform/Tenant IdentityProvider OIDC/SAML federation is specifically to be retired.

## Required invariants
- Native ZITADEL authentication remains the sole login method for RP itself. A user's verified RP-native login and recovery must be ensured prior to disabling upstream identity providers; never infer identity from matching emails.
- Each tenant owns OAuth client configurations and may grant access only to its own explicitly authorized users; no cross-tenant role, membership or credential leakage.
- Global RP User/TenantMembership is the source of authorization; external relying parties cannot assume ZITADEL global roles imply RP tenant RBAC.
- Token issuer must be the *real issuer* advertised by corresponding discovery and verified by JWKS; it must not be synthesized per tenant without separate working issuer instances.
- Externally issued ID/access tokens must have unambiguous audience/client, stable subject, minimal scoped claims, consent/authorization, revocation, and agreed behavior on removed membership.
- Tenant domain cannot bypass redirect allowlists, and clients must use Authorization Code + PKCE; public clients never receive reusable secrets.
- All management operations require current tenant-scoped permissions enforced server-side and privileged platform services cannot silently leak global ZITADEL capabilities to tenant admins.

## Candidate architecture / decision pending ZITADEL compatibility verification
Option A: per-tenant ZITADEL organization/project on the existing instance with shared technical issuer; RP policy enforcement through an issuer-side verifiable authorization mechanism (claims/actions/user grants), tenant-specific applications, tenant-scoped security and aud.
Option B: separately isolated issuer instances/virtual hosts only if required and supported, accepting significantly higher operational and lifecycle cost.
Avoid claiming per-tenant issuer names for option A.

## Acceptance tests for architectural decision
1. Provision two tenant configurations, applications and users (including user with membership in both), verify issuer, discovery, JWKS signature, claims, audience and cross-tenant denial.
2. Verify that disabling/suspending membership immediately or within a documented bounded revocation window prevents new tokens and does not mint grants through stale sessions.
3. Test standard OIDC relying party Authorization Code + PKCE, confidential client credentials, user consent, refresh/logout and rotation.
4. Prove native RP login/CLI/MCP stays working without any inbound federated provider, then test recovery of a federated-only account before federation removal.
5. Test failure/reconcile on ZITADEL provisioning and non-destructive migration/rollback gates.

No final architecture decision or compatibility claims should be made before these checks run in an isolated, compatible ZITADEL test environment.

## Research-backed working decision (not yet a production authorization)
For compatibility with existing global users, select **one dedicated ZITADEL project per RP tenant within the platform's existing ZITADEL organization**, with projectRoleCheck=true, an explicit `rp.tenant.member` project role and per-user assignments derived from active RP TenantMembership records. Organization-per-tenant would require cross-organization users, grants, and potentially a different native login policy; defer unless real ZITADEL E2E shows a need. A tenant owns its logical IDP namespace and clients, **not its own independent OIDC issuer**; the actual shared ZITADEL instance issuer, discovery, and JWKS must be advertised exactly, and relying parties must validate their own client audience and tenant project claims.

Use RP as the source of truth: fail closed until project role assignments are synchronized and tested; deny issuance to any user without current tenancy. A stale role assignment is a cross-tenant breach and requires immediate remediation. No reliance on hasProjectCheck as a substitute for per-user projectRoleCheck. Require role assertion and RBAC checks for application usage, with strict integration tests. In particular, roles with empty grants and previously minted refresh tokens need negative testing.

The management/v1 endpoints in ZITADEL documentation support `POST /management/v1/projects` with `projectRoleCheck`, `POST /management/v1/projects/{id}/roles`, and `POST /management/v1/users/{id}/grants`; these are deprecated in favor of v2 services, so verify against the pinned image before deciding API lifecycle. Source references:
- https://zitadel.com/docs/guides/manage/console/projects-overview
- https://zitadel.com/docs/apis/openidoauth/scopes
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddProject
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddProjectRole
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddUserGrant
- https://zitadel.com/docs/guides/solution-scenarios/restrict-console

**Validation gap:** The approved worktree currently has no Docker, PostgreSQL, or node_modules. Do not treat docs, unit mocks, or this ADR as real ZITADEL compatibility proof. E2E against the release-pinned ZITADEL plus real token validation is a mandatory release gate in stage 10. Public support must remain inactive until that gate passes.
