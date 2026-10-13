# Tenant Identity & SSO — ResourcePortal IdP guide

**Availability:** Implementation candidate only. Tenant OAuth/OIDC issuance must remain disabled until the dedicated, live ZITADEL multi-tenant certification checklist is signed off. Do not assume the provider is production-ready because a project exists or unit tests pass.

## What is supported?

ResourcePortal uses its existing ZITADEL instance as its OIDC authorization server. Each RP tenant receives a **dedicated ZITADEL project and tenant-specific OAuth applications**; RP tenant membership is the source of truth for the project's `rp.tenant.member` user grants. Each relying-party application validates its own client audience and required project role. The actual OIDC `issuer` is **shared** and must equal the issuer in discovery; there is **no tenant-specific issuer URL** in this design.

- **Outbound interactive OIDC:** register Web (confidential), SPA and Native (public) applications using Authorization Code and PKCE S256. Clients must use their precisely allowlisted redirect URLs. A Web client may have a client secret; public clients must not.
- **Incoming RP authentication:** native login to RP through its own ZITADEL project. Existing inbound identity federation from custom OIDC/SAML providers is deprecated and only removed after every impacted user can authenticate and recover a native account.
- **Not supported / not guaranteed:** independently hosted per-tenant issuer domains, per-tenant signing keys, per-tenant SAML IdP issuing assertions, dynamic grant editing from external clients, arbitrary upstream IdP management by tenants, or immediate revocation of an already signed JWT outside the consuming API's validation/expiry policies. Machine-to-machine access uses RP Service Identities, not interactive tenant OIDC.
- **Consent and claims:** role assertion is requested for tenant clients, but real access token claims, consent, refresh and logout semantics **require** the live ZITADEL acceptance tests. Never treat an unaudited role claim as proof of tenant membership.

## Automatic provisioning and activation

The production API sets `TENANT_OIDC_AUTO_ROLLOUT=true` and starts an
unprivileged, retryable reconciler after the schema migration. Every active tenant
with verified native issuer-linked members and no legacy platform-project OAuth
clients gets a ZITADEL project and synchronized `rp.tenant.member` grants.
The operation is re-run periodically, includes tenants created after upgrade, and
uses a per-tenant database lease. An interrupted project creation checks ZITADEL
for the **exact project name** before creating another project. Existing passwords,
MFA, CLI client credentials, service identities and historic accounts are untouched.

Automatic **preparation and activation** are part of a single official RP
upgrade. The production API uses `TENANT_OIDC_ACTIVATION_ALLOWED=auto`, rather
than requiring a platform operator to set `true`. Once *all* active tenants have
passed native identity, legacy client, project/role/grant, secure issuer discovery,
PKCE and JWKS checks, the reconciler enables their tenant OIDC providers.
`false` is the emergency kill switch; explicit tenant activation remains denied
under `auto`. The installer waits for `GET /api/health/tenant-oidc` to return 200,
then records the upgrade as successful. A blocked provider, issuer outage or
unreconciled tenant returns 503 and the upgrade invokes its verified automatic
rollback. An unmatched native identity, existing inbound federation, legacy OAuth
client, invalid issuer or failed ZITADEL operation causes a blocked state, not
silent reassignment or unsafe token issuance. No arbitrary
migration of existing OAuth client IDs or secrets between ZITADEL projects occurs.

The ZITADEL management secret stays **API-only**; it is never given to the
privileged Docker/Swarm worker. Review read-only `GET /api/platform/tenant-oidc`
and `GET /api/platform/identity-providers/retirement-preflight` for state.

## Tenant administrator: configure an application

1. After a successful certified platform update, open tenant **Access → Identity & SSO**. The provider is automatically provisioned and `Active` on eligible installations; no tenant-by-tenant setup or manual activation switch is necessary. An incomplete rollout remains blocked and causes the installer to reject the update.
2. For exceptional recovery only, choose **Provision provider** to request a tenant ZITADEL project. RP validates that the ZITADEL project requires a project and user role grant. Provisioning requires tenant-scoped permissions and functioning management credentials.
3. For exceptional recovery only, choose **Reconcile grants** to map active RP memberships with *verified native ZITADEL identities* to explicit project grants. An upstream identity matched by email is **not** a verified native user.
4. An RP release is not eligible for production until its full real-ZITADEL E2E and automatic schema/image rollback are independently certified on the exact candidate SHA. The published installer then applies the `auto` policy without further clicks. If old OAuth clients remain on the shared platform project, the upgrade blocks rather than silently changing client IDs or secrets.
5. Once status is `Active`, choose **Create application**. Select Web / SPA / Native, enter a meaningful client name and precisely match its HTTPS redirect URL and optional post-logout URL. For Native, approved custom URI schemes or loopback are supported by the explicit validator. No loose HTTP, URL fragments or embedded credentials.
6. Save the `client_id` and any one-time `client_secret` in an approved secret manager. Never record secrets in issue comments, API logs or documentation.
7. In your external application, configure the exact `issuer` returned by RP. Retrieve `/.well-known/openid-configuration` from that issuer and validate its advertised HTTPS JWKS. Confirm token `iss`, signature/key rotation, `sub`, `aud`, expiration and tenant project role, as well as `state`, `nonce` and PKCE in the authentication flow.
8. A user without an active membership and a verified matching native ZITADEL subject **must not** receive a usable project grant. If membership or the provider is disabled, expect upstream grant revocation, check the resulting token behavior and apply short-lived JWT/API-side membership policy as required.
9. Use **Disable** to revoke tracked grants and stop accepting the provider as active in RP. Delete clients before deleting their tenant project. Always perform cleanup in the order clients → project; do not attempt to reassign them to the global RP project.

### REST API

All tenant methods require authentication, active membership and relevant `oauth_application.*` permission; mutation methods also record audit events.

| Request | Purpose |
|---|---|
| `GET /api/tenants/:tenantId/oidc-provider` | Current tenant IdP status, project, issuer, reconciliation summary |
| `POST /api/tenants/:tenantId/oidc-provider/provision` | Create and verify project; leave disabled |
| `POST /api/tenants/:tenantId/oidc-provider/reconcile-grants` | Sync RP-native user grants; fail closed |
| `POST /api/tenants/:tenantId/oidc-provider/activate` | Explicit activation only with operator-controlled `true`; not an override of automatic `auto` eligibility |
| `POST /api/tenants/:tenantId/oidc-provider/disable` | Revoke known grants, mark provider disabled |
| `DELETE /api/tenants/:tenantId/oidc-provider` | Remove unused project after clients are removed |
| `GET/POST /api/tenants/:tenantId/oauth-applications` | List or create tenant-specific relying-party clients |
| `GET/PATCH/DELETE /api/tenants/:tenantId/oauth-applications/:applicationId` | Retrieve/update/remove a client |
| `POST /api/tenants/:tenantId/oauth-applications/:applicationId/rotate-credentials` | Rotate credentials where supported |

A **Platform Admin** can read `GET /api/platform/tenant-oidc` and `GET /api/platform/identity-providers/retirement-preflight`, but it does not automatically inherit tenant admin privileges or access to tenant user grants.

### SDK / CLI / MCP

TypeScript SDK:
```ts
const provider = await client.tenantOidc.get(tenantId);
await client.tenantOidc.provision(tenantId);
await client.tenantOidc.reconcileGrants(tenantId);
// Normal eligible installations do NOT need these manual commands after updating.
// Activate is automatic only in the rollout worker, not via tenant REST/CLI.
```

CLI:
```text
rp tenant-oidc show TENANT_ID
rp tenant-oidc provision TENANT_ID
rp tenant-oidc reconcile TENANT_ID
rp tenant-oidc activate TENANT_ID
rp tenant-oidc disable TENANT_ID
rp native-login-migration preflight
```

Tenant MCP exposes `resourceportal_manage_identity` operations `get_tenant_oidc`, `provision_tenant_oidc`, `reconcile_tenant_oidc`, `activate_tenant_oidc`, `disable_tenant_oidc`, `delete_tenant_oidc`. Platform Admin MCP exposes read-only tenant rollout state and native login preflight. MCP tools use existing RP authentication and tenant permissions; they must not be used to circumvent certification gates.

## Migrating RP login away from external IdPs

This is a **separate** track from outbound tenant OIDC. An RP login is always in the platform's native ZITADEL project. Use the operator-only `GET /api/platform/identity-providers/retirement-preflight` to identify active external providers, sessions, old tenant policies and accounts without native issuer links. That check is not proof that a password/passkey actually works.

A responsible operator must verify native login and recovery on every affected account, break-glass, MFA, passkeys and CLI/MCP OAuth. Revoke old externally-authenticated sessions, correct tenant auth policies, remove upstream providers from the *actual hosted ZITADEL login policy* and test denial of external federation. Only then enable `RP_NATIVE_LOGIN_ONLY=true`. The production API supports `RP_NATIVE_LOGIN_ONLY=auto`: for RP installations with **zero inbound provider records, linked accounts, inbound-only tenant policies and federated sessions**, it blocks inbound provider selection and create/update APIs without manual per-tenant migration. Explicit `true` remains available after the operator's full cutover checklist; `false` preserves legacy compatibility. Old database identity links are never deleted as part of this migration. Do not delete them automatically, and do not match accounts solely by email.

## Testing and release state

See `docs/tenant-oidc-e2e-certification.md`, `docs/tenant-idp-native-only-cutover.md` and `docs/tenant-oidc-release-gates.md`. `GET /api/health/tenant-oidc` is an intentionally minimal installer readiness probe, not a proof of human credentials, consent, MFA or signed-token flows. A standalone `npm --workspace @resource-portal/api run test:tenant-oidc-live-preflight` checks availability of configured issuer, real OIDC discovery/JWKS and project checks; it **does not** replace browser-based authorization, consent, real JWT roles, two-tenant cross-access denial, refresh-token revocation or an automatic installer rollback test. If any live gate is unverified, do not advertise RP tenant SSO as ready.
