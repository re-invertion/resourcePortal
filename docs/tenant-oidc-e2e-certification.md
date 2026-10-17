# Tenant OIDC release certification — mandatory live gate

**Status: PARTIALLY CERTIFIED / PRODUCTION CUTOVER BLOCKED (2026-10-12).** The isolated ZITADEL v4.17.0 HTTPS end-to-end workflow now checks real management endpoints, two tenant projects, live browser Authorization Code + PKCE, signed OIDC ID/access tokens, tenant roles, refresh, role revocation and RP-initiated logout. It does **not** certify migration/recovery of existing RP users, production MFA/passkeys and CLI/MCP, public CA/certificate deployment, every client type's interactive login or all upstream failure recovery cases. No production tenant SSO activation, federation cutover, merge/release or deploy is authorized by this document until all mandatory cases have verified evidence.

## One-click activation candidate (not yet released)

The current candidate changes the production installer to `TENANT_OIDC_ACTIVATION_ALLOWED=auto`.
The isolated HTTPS ZITADEL E2E source now requires automatic provider activation
for **two** distinct tenant projects and a `ready` rollout status, with no manual
`activate()` call. This is an acceptance criterion for the next candidate SHA,
**not** evidence that the updated workflow already passed. The release must also
verify native RP browser authentication/recovery, CLI/MCP, upgrade from the
previous published release and automatic failure-injected rollback. CI must remain
blocked until those real checks pass; database/JWKS readiness cannot substitute
for end-to-end proof of password, MFA/passkey or consent behavior.

The official upgrade probes public `GET /api/health/tenant-oidc` (no tenant metadata).
It returns 200 only after all active tenant providers are ready and issuer checks
pass, otherwise 503; upgrade invokes verified rollback on timeout. An existing
shared-project OAuth client, incoming federation, invalid native identity or
upstream ZITADEL outage prevents automatic activation. Old client IDs/secrets
cannot be safely moved between projects automatically and must remain intact.

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

## Automated real HTTPS ZITADEL evidence

- Required GitHub workflow: `Tenant OIDC Real HTTPS ZITADEL E2E`, with reusable invocation by `ResourcePortal Release Readiness` for changes to identity/federation or milestones.
- Isolated runner executes `bash scripts/run-tenant-oidc-https-e2e.sh` with pinned ZITADEL v4.17.0, real PostgreSQL migrations, and an ephemeral **locally trusted** HTTPS certificate on `https://localhost:8443`. The script refuses to run outside ephemeral GitHub Actions and cleans up databases and ZITADEL resources.
- [Run #38314052473](https://github.com/re-invertion/resourcePortal/actions/runs/38314052473): PASS for real browser code+PKCE, JWT `iss`/`aud`/`sub`/`nonce`/signature, role grant, refresh and removal of the revoked role from a newly refreshed JWT.
- [Run #38314531215](https://github.com/re-invertion/resourcePortal/actions/runs/38314531215): PASS with additional real RP-initiated browser logout. Negative JWT foreign audience/role checks were added subsequently and must be green for the **latest** commit before being considered certified.
- [Release Readiness #38309963384](https://github.com/re-invertion/resourcePortal/actions/runs/38309963384): PASS for prior published API startup/read/write and session compatibility after real PostgreSQL migration and automatic image rollback. Subsequent commits require fresh CI.
- These tests use temporary native identities; they are **not** acceptance of actual customer account migration or production TLS/MFA recovery. Do not mark pending table rows complete based on related but narrower evidence.

## Required LIVE E2E in an isolated, release-pinned ZITADEL environment

Use dedicated test accounts and an operator-approved isolated RP installation, *not* production users or their IdPs.

| Case | Required evidence | Result |
|---|---|---|
| Tenant A and B | Distinct projects and OAuth clients; shared real issuer (no invented tenant issuer) | **PASS isolated** |
| Membership in A only | A client accepts verified user; B login/token role check denied | **Partial**: grant absent in B, explicit B login denial pending |
| Membership in A and B | Project-ID-scoped role claims, no leakage of tenant grants or B audience into A token | **Partial**: A claims verified, both memberships and signed foreign-claim denial pending |
| User with no native identity | Provision/reconcile denied; no identity linked by matching email | Pending |
| OIDC login Web | Authorization Code + PKCE S256, state/nonce, consent, ID/access token signatures, iss/sub/aud/exp and role claim | **Partial**: signed browser/token flow PASS; explicit consent prompt coverage pending |
| OIDC login SPA / Native | Public client has no secret; strict redirect allowlist and PKCE | **Partial**: public SPA credentials verified; SPA/Native interactive login pending |
| User suspended / membership removed | Upstream grant revoked, **new** tokens denied; test existing JWT expiry and refresh rotation/revocation windows | **Partial**: remote grant revoked and refreshed JWT lost role; signed JWT expiry/other sessions pending |
| Client disabled / secret rotated / deleted | Old credentials and new authorization attempts denied; old sessions/logout behavior measured | Pending |
| Provisioning outage | Upstream HTTP timeouts/retries, no orphan authorization, no unsafe Active status or cross-tenant grant | Pending |
| Native RP authentication | Browser/BFF, CLI OAuth device flow, tenant MCP, admin MCP, passkey/MFA, recovery and platform break-glass | Pending |
| Inbound federation retirement | User migration first; ZITADEL hosted-login upstream policy actually removed; legacy IdP selection denied; no account lockout | Pending |
| Upgrade and rollback | Old shared-project OAuth apps kept intact or explicitly migrated, migration idempotent, release images and installer automatic rollback tested | **PASS isolated current schema**; prior/current SHA certification required for final release |

Record screenshots/structured test logs, actual version/image digests, issuer and JWKS kid, *redacted* token claim sets, user and tenant test IDs, observed refresh/revocation latency, CI run URL and sign-off. Never store tokens, passwords or client secrets in the report.

## Mandatory operational controls

1. Do not merge/release the automatic-activation candidate until all relevant live E2E cases and exact-SHA rollback tests have passed. Production then uses `TENANT_OIDC_ACTIVATION_ALLOWED=auto` and a worker-only activation path. Explicit `false` remains an emergency stop.
2. The candidate sets `RP_NATIVE_LOGIN_ONLY=auto` only for installations without any inbound IdP, linked identity, mandatory policy or federated session. Native login and recovery still require release-level interactive acceptance. Use `false` as an explicit legacy-compatible recovery override.
3. A tenant cannot turn on RP-wide authentication changes from the tenant UI; the legacy management view no longer exposes a direct auth-policy mutation.
4. Enforce destination-branch review and all required GitHub checks. Main merge must go through protected queue; it must trigger official release pipeline with tested image-only rollback. If automatic rollback is not guaranteed, release **must fail closed**.
5. If any live test fails, **do not** merge or release a production-auto-activation image and **do not** label tenant IdP supported. Preserve old native RP login and legacy customer integrations; file remediation issues.

References:
- https://zitadel.com/docs/guides/integrate/retrieve-user-roles
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.ListProjectRoles
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddUserGrant
- https://zitadel.com/docs/reference/api/management/zitadel.management.v1.ManagementService.AddOIDCApp
