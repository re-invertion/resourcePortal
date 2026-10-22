# Issue 238 and RP report 027f46a2: incoming IdP retirement

Scope: tenant incoming legacy third-party login and its authorization policy.
Retain tenant-issued outbound OIDC, native ResourcePortal login, trusted
machine/service identity authentication and tenant RBAC.

## Inventory from main c98d22f

- AuthFlowService can still select upstream incoming platform/tenant IdPs
  before native-only cutover.
- AuthSessionService persists authenticatedIdpId from signed authentication
  and checks native-only before continuing old sessions.
- OidcAuthService derives authentication provenance from verified signed claims
  or nonce-bound server-side proofs; do not use identity links/headers.
- TenantContextGuard previously checked requireTenantIdentityProvider but not
  standalone allowPlatformLogin=false.
- Tenant MCP bypasses TenantContextGuard for anonymous protocol discovery;
  previously TenantMcpAccessGuard did not enforce provider provenance for
  interactive callers.
- NativeLoginModeService allows automatic cutover only when no incoming IdPs,
  linked users, restrictive policies or active external sessions remain and
  the configured issuer is HTTPS.
- Incoming legacy IdentityProvider, UserIdentity, PortalSession and
  TenantAuthPolicy records may still be necessary for existing users.
- Outbound tenant-issued OIDC clients are separate from incoming federation.

## Patch

Enforce both allowPlatformLogin=false and requireTenantIdentityProvider=true
on tenant HTTP session, signed user bearer and interactive tenant MCP requests
unless native-only cutover is active. The provider must be enabled, scoped to
the requested tenant and match verified authentication provenance.
Anonymous MCP discovery and service-identity authorization remain intact.
Tests cover denial, tenant provider acceptance, disabled/wrong provider, native
cutover and MCP.

## Destructive retirement decision required from owner

Read-only preflight must establish counts of configured incoming IdPs, linked
identities, active federated sessions and restrictive tenant policies.
If all counts are zero and native login/recovery are certified, final cutover
can proceed without deleting user or tenant records. Otherwise the owner must
choose how users with external-only credentials receive verified native
credentials, account continuity and recovery, and when external sessions can
be revoked. Do not delete IdPs, mutate accounts, silently relax policy or
force native-only on a populated installation automatically.

Keep RP report 027f46a2 and GitHub issue 238 open until verified migration,
full feature retirement, signed release and post-deployment acceptance.
This security patch fixes missing resource-boundary checks; it does not
claim completed destructive removal of incoming legacy auth.
