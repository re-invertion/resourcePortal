# ResourcePortal native-only login cutover — release runbook

**Status: not authorized for rollout; feature flag OFF by default.** This runbook separates existing inbound federation (external IdPs used to sign in to RP) from outbound tenant OIDC (RP/ZITADEL authenticating users for tenants' applications).

## Preparation: no user lockout
1. Run protected `GET /api/platform/identity-providers/retirement-preflight` as a verified RP platform administrator. It reports enabled provider configuration, tenant login policies, active sessions with external IdP provenance, and users linked to upstream IdPs lacking any native RP ZITADEL identity. It never returns raw user identities.
2. **Every user** who previously logged in through upstream OIDC/SAML must complete a working native ZITADEL login or supervised migration. Native `UserIdentity` rows alone are insufficient evidence of usable local credentials. Verify MFA, passkeys, password recovery and admin break-glass with real interactive login.
3. For each tenant, remove legacy policies requiring an external tenant IdP (`requireTenantIdentityProvider`) or disallowing native login (`allowPlatformLogin`). Keep a rollback plan for the policy changes.
4. Revoke sessions tied to federated provider authentication and verify the session expiry / logout semantics. Check for stale tokens in CLI, SDK and MCP.
5. Unlink/disable upstream identity providers in ZITADEL's *actual* login policy (not only RP database flags), while retaining enough audit information to restore a service on rollback. Verify there is no unsolicited/fallback federated path in ZITADEL hosted login.
6. Verify each tenant application OIDC role-check and authentication flow separately. Outbound tenant OIDC uses one real shared issuer (per ADR) until tests prove another supported architecture.

## Native-only switch
- `RP_NATIVE_LOGIN_ONLY=true` **only after** the checks above; defaults to false for compatibility. This mode removes provider selection from RP's login endpoint and rejects explicit legacy `identityProviderId` selections and writes to provider configuration APIs with HTTP 410. Existing provider rows remain for audit/recovery; DELETE remains supported for cleanup.
- The tenant request guard stops enforcing deprecated inbound-IdP provenance only in native-only mode. During the transition, existing inbound policy behavior remains unchanged.
- Do not announce removal as complete until ZITADEL's global organization login policy has actually been validated. A user could otherwise choose an upstream IdP directly in ZITADEL without passing RP's explicit provider-selection parameter.

## Verification / rollback
- Required runtime checks: native registration, login, password reset, MFA, passkey, tenants' membership and RBAC; admin break-glass; CLI and MCP client authentication; outbound OIDC claims, issuer, JWKS, revoked grants; previous-version compatibility.
- This flag and database migration are reversible; provider configuration and user identity links are **not** dropped in the first release. If a release fails, restore the last known safe release with tested automatic rollback; roll back configuration separately if necessary, using a documented operator process.
- Do not delete external credentials, linked user records, audit or ZITADEL projects before native login and recovery are verified for affected users. No auto-linking on email matches.
- This document does not claim the production cutover has occurred or live ZITADEL E2E passed.
