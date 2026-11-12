# Unified Identity / SSO grant migration (#430)

Status: **implementation candidate; not production certified**. Related: #398, #286, #399. This document is an operator contract, not authorization to turn on an issuer-global Action.

## Identity and authorization

One `User` / `UserIdentity` can belong to multiple tenants through `TenantMembership`. A membership owns direct roles, inherited group roles and independent application grants. The legacy `TenantAppConsumer` row is a temporary migration marker only; it must not be used by permission guards, invitation handlers or the UI to classify people.

A managed OAuth/OIDC authorization MUST require all of:

- An authenticated *ZITADEL-signed* subject matching an active `UserIdentity(issuer, externalSubject)` for an active user. Never match by email alone or by project role claims.
- An active `TenantMembership` for the application's *exact* tenant and an active tenant.
- The `sso-login` role assigned directly or through a tenant group. It has zero RP Permission/RolePermission bindings.
- An **enabled** grant matching the exact registered client ID through `OAuthApplication(tenantId, clientId)` and `TenantAppClientGrant(membershipId, oauthApplicationId)`. Never infer a client grant from Viewer/Owner/Admin, group management roles, or a ZITADEL project role.
- A valid tenant OIDC provider/issuer and matching ZITADEL project. Unrecognized, suspended, disabled, cross-tenant or unreachable entries deny.

For RP's *native* clients, `TenantNativeAppGrant` stores separate `web` and `cli` grants. Those keys MUST map to the actually registered `OIDC_CLIENT_ID` and `OIDC_CLI_CLIENT_ID` in the signed Actions V2 callback. A client does not inherit the other client's authorization. RP HTTP APIs separately enforce RP RolePermission bindings; `sso-login` alone must not grant tenant enumeration, management or global tenant creation. `membership.update` is mandatory to modify grants, and self-grant is forbidden.

`TenantAppClientGrant` grants may be disabled without deletion to preserve audit history and to deny refresh. Revoking an app grant or SSO role needs the issuer-global pre-token gate active in order to reject refresh; downstream access tokens remain valid until expiration unless introspection/revocation is enforced by the resource server.

## Deployment order

1. Take an encrypted PostgreSQL backup and validate that a point-in-time restore works. Record exact pre-upgrade image digest, branch SHA, ZITADEL issuer/project bindings and Action webhook configuration. Establish a maintenance window and freeze membership/SSO mutations.
2. Run Prisma migration `20261112094000_unified_identity_expand` and schema validation. Never run `prisma db push` as a shortcut. Preserve legacy markers, existing IDs, roles and grants. Backfill provenance is stored in `Iam430BackfillAudit`.
3. Check row counts and sample application/member relationships against the backup. Backfill `sso-login` only for identities that previously had tenant management roles or app-only client access. For RP members, backfill existing tenant OAuth apps because the old project role permitted all same-project apps; never grant a foreign tenant's app. Backfill RP Web/CLI only for identities that had native RP access under the former non-App-Consumer policy. This is **preservation** of historical access, not a reason to grant new applications added after migration.
4. Deploy API/Web/SDK/CLI with new per-client permission enforcement, and verify recovery login, invitations, membership lookup, tenant/RBAC isolation and SSO deny matrix in a disposable environment.
5. Certify ZITADEL Actions V2 over real pinned HTTPS *before* binding it to live global `preaccesstoken` execution: verify signed HMAC request, actual client ID, tenant, issuer, subject, no role bypass, unknown/DCR client behavior, refresh denial following revoke/suspension, Web vs CLI separation and behavior during database/network outage. Do not enable flags or unpause production grants on mocked or merely provisioning-level results.
6. Only after release checks, backup/restore and operator recovery dry run pass may production change control authorize deployment.

Known deployment blocker at development stage: bootstrap login/invitation acceptance and dynamic-client-registration behavior need explicit reviewed treatment under issuer-global **default deny**. Do not bypass this by allowing unknown clients.

## Reversible migration / operator rollback

Rollback is **not** a blind `migrate down`, which Prisma does not supply. The old binary expects app grants exclusively under `TenantAppConsumer`; the new binary supports any tenant member. A safe rollback must *fail closed* rather than discard new grant rows:

1. Stop grant/invitation writes. Disable new platform action bindings only under verified change control and ensure the old issuer behavior cannot issue unauthorized tokens.
2. Confirm an encrypted pre-upgrade backup can be restored to a *disposable* database and that exact old API and Web images are available. Save an independent export of all `TenantNativeAppGrant`, invitation keys and `Iam430BackfillAudit` rows for forensic recovery.
3. Run `docs/iam430-rollback-preflight.sql` as read-only under a transaction. If it reports any post-migration app grants that cannot be represented by a legacy `TenantAppConsumer`, post-migration native client access, role/entitlement divergence, unknown app/client, or missing historical backup, **abort automated rollback**. Do not delete user records or merge users on email.
4. Prefer tested database snapshot restore and original images as a single coordinated operation. Only if snapshot restore is unavailable and the preflight is clean may an operator prepare a separately reviewed schema-down migration: delete only records identified by `Iam430BackfillAudit`, restore the legacy grant foreign key, then drop the new native grant table/column and audit ledger. Do not delete original `TenantAppConsumer` rows or untouched `TenantAppClientGrant` rows.
5. Verify old auth, RBAC, OIDC Web/CLI, grant revocation and recovery. If any test fails, leave the system in maintenance/fail-closed state and restore the verified database backup. An installer reporting that backup/restore exists is not proof of a successful rollback execution.

## Duplicate identity resolution (no automatic email merge)

A matching email is a *hint for investigation*, never proof two User records represent one person. Present both immutable User IDs and provider-subject pairs to an authorized tenant/platform operator; require both identities to complete reauthentication or another approved strong proof of possession. Freeze privileges and active sessions, obtain auditable human approval and archive a full database snapshot. Lock both User records in a consistent ID order, verify no conflicting UserIdentity issuer/subject uniqueness, tenant membership, role, group, app-client or external ZITADEL grants, and explicitly resolve conflict policy per tenant. Transfer references in one transaction with reversible mapping table and audit, invalidate sessions/refresh tokens, then retest isolation and rollback on a disposable clone. Never merge by just normalized email, and never erase the source identity before confirmation.

## Minimum acceptance matrix

| User/tenant grants | HA OAuth client | RP Web | RP CLI | RP HTTP management |
|---|---|---|---|---|
| `sso-login` + HA only | allow | deny | deny | deny |
| `sso-login` + RP Web only | deny | allow | deny | deny |
| `sso-login` + RP Web + Viewer | deny | allow | deny | Viewer only |
| `sso-login` + RP Web + Admin | deny | allow | deny | Admin only |
| `sso-login` + Web + CLI | deny | allow | allow | deny without RBAC |
| RP Admin without `sso-login` | deny | deny | deny | subject to existing authenticated RP session policy |
| Any wrong-tenant grant, suspended user/member, disabled provider | deny | deny | deny | deny |

**CI sign-off must include** Prisma migrations on a copy of real legacy data, backup/restore, exact-client refresh/token revocation over live isolated HTTPS, native Web/CLI real clients, installer test, SDK and CLI contract, global createTenant, cross-tenant access, code review and release readiness. Any skipped real certification means #430 stays open and its PR stays unmerged.
