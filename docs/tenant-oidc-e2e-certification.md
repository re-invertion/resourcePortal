# Tenant OIDC release certification — mandatory live gate

**Status: BLOCKED (2026-10-12).** Unit tests, mocked provider contract tests and a read-only discovery/JWKS preflight are **not** proof of a working identity provider. No production tenant SSO activation, federation cutover, migration of users, merge/release or deploy is authorized by this document.

## Local reproducible checks

- `npm --workspace @resource-portal/api run build`
- `npm --workspace @resource-portal/api run lint`
- `npm --workspace @resource-portal/api test`
- `npm --workspace @resource-portal/web run lint`
- `npm --workspace @resource-portal/web test`
- `npm --workspace @resource-portal/sdk test`
- `npm --workspace @resource-portal/cli test`
- `npm --workspace @resource-portal/api run test:tenant-oidc-live-preflight`

The final command is intentionally **fail-closed** if `OIDC_ISSUER_URL`, `ZITADEL_ORGANIZATION_ID`, `ZITADEL_MANAGEMENT_TOKEN` or `ZITADEL_TEST_PROJECT_ID` is absent. Set `ZITADEL_MANAGEMENT_URL` if the management API is on a different HTTPS origin. The script checks the actual issuer, OIDC discovery, advertised HTTPS JWKS and whether the named project has mandatory role and project checks. It **cannot** certify token security or grant revocation alone.

## Required LIVE E2E in an isolated, release-pinned ZITADEL environment

Use dedicated test accounts and an operator-approved isolated RP installation, *not* production users or their IdPs.

| Case | Required evidence | Result |
|---|---|---|
| Tenant A and B | Distinct projects and OAuth clients; shared real issuer (no invented tenant issuer) | Pending |
| Membership in A only | A client accepts verified user; B login/token role check denied | Pending |
| Membership in A and B | Project-ID-scoped role claims, no leakage of tenant grants or B audience into A token | Pending |
| User with no native identity | Provision/reconcile denied; no identity linked by matching email | Pending |
| OIDC login Web | Authorization Code + PKCE S256, state/nonce, consent, ID/access token signatures, iss/sub/aud/exp and role claim | Pending |
| OIDC login SPA / Native | Public client has no secret; strict redirect allowlist and PKCE | Pending |
| User suspended / membership removed | Upstream grant revoked, **new** tokens denied; test existing JWT expiry and refresh rotation/revocation windows | Pending |
| Client disabled / secret rotated / deleted | Old credentials and new authorization attempts denied; old sessions/logout behavior measured | Pending |
| Provisioning outage | Upstream HTTP timeouts/retries, no orphan authorization, no unsafe Active status or cross-tenant grant | Pending |
| Native RP authentication | Browser/BFF, CLI OAuth device flow, tenant MCP, admin MCP, passkey/MFA, recovery and platform break-glass | Pending |
| Inbound federation retirement | User migration first; ZITADEL hosted-login upstream policy actually removed; legacy IdP selection denied; no account lockout | Pending |
| Upgrade and rollback | Old shared-project OAuth apps kept intact or explicitly migrated, migration idempotent, release images and installer automatic rollback tested | Pending |

Record screenshots/structured test logs, actual version/image digests, issuer and JWKS kid, *redacted* token claim sets, user and tenant test IDs, observed refresh/revocation latency, CI run URL and sign-off. Never store tokens, passwords or client secrets in the report.

## Mandatory operational controls

1. Keep `TENANT_OIDC_ACTIVATION_ALLOWED` unset/false until all live E2E cases pass. The API rejects activation by default.
2. Keep `RP_NATIVE_LOGIN_ONLY` unset/false until the incoming-federation preflight is reviewed and native login and recovery are actually verified for every affected account.
3. A tenant cannot turn on RP-wide authentication changes from the tenant UI; the legacy management view no longer exposes a direct auth-policy mutation.
4. Enforce destination-branch review and all required GitHub checks. Main merge must go through protected queue; it must trigger official release pipeline with tested image-only rollback. If automatic rollback is not guaranteed, release **must fail closed**.
5. If any live test fails, **do not** set activation flag and **do not** label tenant IdP supported. Preserve old native RP login and legacy customer integrations; file remediation issues.

References:
- https://zitadel.com/docs/guides/integrate/retrieve-user-roles
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.ListProjectRoles
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddUserGrant
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddOIDCApp
