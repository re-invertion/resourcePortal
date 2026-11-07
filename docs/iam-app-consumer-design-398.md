# App Consumer authorization (issue #398) — implementation and safety design

## Baseline and verified proof

Published v0.2.144 blocks active role-free members from tenant inventory and tenant HTTP endpoints. PR #404 validates signed ZITADEL v4.17.0 Actions V2 preaccesstoken with exact application.client_id and safe client-specific refresh denial in real HTTPS E2E. Neither is a deployed App Consumer feature.

The ZITADEL tenant project currently grants rp.tenant.member at **project** level via TenantOidcService.reconcileGrants. ProjectRoleCheck is not an OAuth-client authorization check. Existing membership invitations require nonempty RP roleIds. An App Consumer must instead use an explicit zero-RP-permission category and independent client grants.

## Data and identity authority

- A dedicated TenantAppConsumer record references one role-free TenantMembership. Presence of a membership alone cannot grant RP read, billing, MCP, CLI, terminal or deployment access. Keep the zero-permission tenant boundary from v0.2.144.
- TenantAppClientGrant links consumer membership to the exact OAuthApplication id. The application's globally unique clientId and tenant/projectId are checked on each request. Unknown clients default deny. Use enabled/revoked timestamps rather than deleting grants on revoke; audit every transition.
- A TenantAppInvitationGrant links a pending, hashed-token TenantInvitation to eligible OAuthApplication IDs. Invitation roles remain [] and acceptance creates a role-free membership plus consumer/grants atomically. No role is silently assigned.
- An OIDC callback derives identity exclusively from a verified ZITADEL signature and immutable user.id, resolves a single matching UserIdentity issuer+subject and tenant project+OAuthApplication clientId, validates active User and membership, and checks enabled grants. Never accept email, clientId or tenant from unsignatured user fields as authorization.
- Existing RP operators must not experience silent lockout. Before enforcing this gate for a tenant, migrate existing explicit client entitlements or use a documented limited legacy mode. Newly enrolled App Consumers must always default deny until granted. Only owner/admin bypasses should be explicit and audited.
- Revoking app grants must prevent new authorization and refresh. An already issued JWT may remain valid to its expiry; the UI must explain that third-party sessions are outside RP's control.

## Rollout and rollback gate

The current docs/release-validation-policy.md forbids image-only Fast Fix release with a Prisma schema change. Other installer and release docs describe a tested policy with exact-SHA RP+ZITADEL pg_dump/pg_restore, restored source API and ZITADEL eventstore, signed provenance and injected rollback failure. This feature must use the exact-SHA real upgrade-and-restore verification, not a handwritten assertion or a flag override. If the CI gate does not certify the migration, the feature remains unreleased.

Before any production cutover: negative E2E 2 users x 2 clients x 2 tenants, unknown client/subject, removed user, suspended member, wrong issuer, action unavailability/signature/replay, concurrent revoke/refresh, partial ZITADEL failure, and legacy operator logins. Do not enable production gate before all have passed.

## Implemented draft: signed Actions V2 entitlement boundary (unreleased)

The feature branch defines `POST /api/app-consumer-actions/preaccesstoken` as an
independent machine-to-machine authorization callback. It accepts the
`ZITADEL-Signature` (older `X-ZITADEL-Signature`) only when it is an
HMAC-SHA256 of the **exact HTTP request bytes**, with a five-minute timestamp
bound. It obtains the immutable subject only from the signed payload
`user.id`, and the exact OAuth client from `application.client_id`;
it evaluates the server-side `TenantAppClientGrant` on every invocation. It
returns HTTP 403 for unknown/disabled/removed client access and HTTP 401 for
unverified signatures, without leaking grants, email addresses or tokens.
Existing native RP login client ID is a narrowly explicit exemption;
admin/member permissions cannot be inferred from the target's payload.

**Fail-closed installation:** the callback returns 503 unless both
`RP_APP_CONSUMER_ACTIONS_V2_ENABLED=true` and
`RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true` are explicitly provided together
with `RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY` (at least 32 characters). The
environment validator rejects a partial configuration. With the gates off,
tenant OIDC reconciliation **excludes** App Consumers from project-wide
`rp.tenant.member` grants and revokes previously tracked App Consumer grants.
The API/UI schema alone therefore cannot silently authorize a new App User
to every OAuth application.

Do not register the callback against a live/shared ZITADEL Actions execution
until an isolated full (2 users × 2 clients × 2 tenants) ZITADEL browser test
validates authorization, refresh, legacy RP login, target downtime, suspension,
revocation and no cross-client/session replay. The proof test in PR #404
specifically validates *mechanism feasibility* but does not certify production
deployment of this new callback.

This branch also changes Prisma schema. The release gate explicitly forbids
merging/publishing such changes until independent source-DB backup, target
migration, source-DB restore and previous-API read/write checks are automated
and prove all supported source upgrade paths. Do not override this restriction
by labeling the PR `fastfix`, disabling a workflow or manually creating a tag.

## Global RP create-tenant boundary

App User must not be able to self-upgrade to Tenant Owner by calling the global
`POST /api/tenants` endpoint, even though that endpoint normally allows any
authenticated RP user to create their own tenant. The create path now checks
for active App Consumer membership under a PostgreSQL user-row lock before
creating Tenant/Owner records. Tenant invitation acceptance takes the same
lock and rejects mixing RP role-bearing membership with an application-only
identity in either direction. Operators should use a distinct native ZITADEL
identity for App Users rather than converting the same owner account into an
app-only consumer. Tests assert that blocked paths never create a tenant or
membership and that existing role-bearing owner onboarding still works.

## Native RP client separation

The signed Actions V2 callback now evaluates the native RP OAuth client against
any App Consumer record for the exact issuer and immutable ZITADEL subject.
Known App Consumers, including suspended ones, cannot receive tokens for the
RP native login client. Unrelated existing RP users and first-time native
registration retain normal login; a database error denies instead of bypassing
the check. This does not replace an isolated real-ZITADEL grant-matrix E2E or
production provisioning/certification of the webhook target.
