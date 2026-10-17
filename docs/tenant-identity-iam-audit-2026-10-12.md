# IAM audit — tenant outbound OIDC and native RP sign-in

Baseline: main @ 0801aacf3d58f8a5732bad25a84e93e94f79f559. This report records verified source-code observations, not a claim that tenant IdP is implemented.

## Current topology
- RP web BFF and API use platform ZITADEL OIDC, PortalSession, global User/UserIdentity and TenantMembership; UserIdentity has unique (issuer, externalSubject) and optional identityProviderId.
- Inbound federation is implemented as IdentityProvider (Platform or Tenant, OIDC/SAML); TenantAuthPolicy permits/mandates upstream federated login. Auth flow accepts tenantId/identityProviderId; tenant-context guard enforces requireTenantIdentityProvider. ZITADEL provider provisioning and login-policy linking exist.
- Tenant OAuthApplication already supports Web, SPA, Native and Machine with redirect/post-logout URIs, ZITADEL app/client ID, encrypted client secret, rotation and tenant CRUD protected by oauth_application.* permissions.
- Critical: ZitadelOAuthApplicationService.projectPath() always uses global ZITADEL_PROJECT_ID and organizationId() always uses global ZITADEL_ORGANIZATION_ID. Consequently tenant-owned OAuthApplication is a tenant-scoped RP record but NOT a tenant-isolated ZITADEL project/organization.
- ServiceIdentity exists separately for M2M and maps tenant roles. Existing CLI/MCP authentication depends on platform OIDC configuration.

## Code touchpoints
- prisma/schema.prisma: UserIdentity, PortalSession, TenantAuthPolicy, IdentityProvider, OAuthApplication, ServiceIdentity, TenantMembership, TenantGroup/Role.
- src/auth/auth-flow.service.ts, auth.controller.ts, oidc-auth.service.ts, tenant-context.guard.ts, and dto/login-query.dto.ts.
- src/identity-providers/* tenant and platform controllers/services/ZITADEL sync.
- src/oauth-applications/* and src/service-identities/*.
- src/mcp/tenant-mcp-protocol.service.ts and admin-mcp-protocol.service.ts.
- Web auth.tsx, tenant-access-pages.tsx, platform-identity-pages.tsx, platform-final-pages.tsx and associated tests; SDK, CLI and docs.
- Auth login still renders provider choices; removing only UI is insufficient.

## Risks and required contract decisions
1. Native RP login vs upstream federation must not be confused with RP acting as an OAuth/OIDC provider for applications. Preserve BFF sessions, CLI/MCP and OAuth machine credentials.
2. ZITADEL organizations do not automatically imply separate OIDC issuers. Validate issuer/discovery/JWKS, client audience and tenant-specific grants using running compatible ZITADEL before locking design; do not publish misleading per-tenant metadata.
3. Tenant-bound OAuth clients require enforced membership/grants and tenant-specific claims. A client registered in shared project could otherwise consume unrelated identity.
4. Never delete inbound provider rows or ZITADEL config until users linked exclusively through them have verified native login/recovery. Do not merge users by email only. Log remediation and maintain admin break-glass.
5. Implement non-destructive expand/contract migrations and release/rollback compatibility checks; test prior-version clients, guard bypass, stale credentials and multi-tenant memberships.
6. Existing inbound identity provider routes have third-party consumers via SDK, CLI and MCP; retirement must explicitly address their contracts and tests.

## Next step
ADR and integration validation: choose verified ZITADEL tenant-org/project model, clarify one shared issuer vs separate issuers, user lifecycle, consent, grants, security claims, and migration gates. No production changes until end-to-end isolation tests pass.
