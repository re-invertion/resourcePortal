# App Consumer authorization (issue #398) — implementation and safety design

## Baseline and verified proof

Published v0.2.144 blocks active role-free members from tenant inventory and tenant HTTP endpoints. PR #404 validates signed ZITADEL v4.17.0 Actions V2 preaccesstoken with exact application.client_id and safe client-specific refresh denial in real HTTPS E2E. Neither is a deployed App Consumer feature.

The ZITADEL tenant project currently grants rp.tenant.member at **project** level via TenantOidcService.reconcileGrants. ProjectRoleCheck is not an OAuth-client authorization check. Existing membership invitations require nonempty RP roleIds. An App Consumer must instead use an explicit zero-RP-permission category and independent client grants.

## Data and identity authority

- A dedicated TenantAppConsumer record references one role-free TenantMembership. Presence of a membership alone cannot grant RP read, billing, MCP, CLI, terminal or deployment access. Keep the zero-permission tenant boundary from v0.2.144.
- TenantAppClientGrant links consumer membership to the exact OAuthApplication id. The application's globally unique clientId and tenant/projectId are checked on each request. Unknown clients default deny. Use enabled/revoked timestamps rather than deleting grants on revoke; audit every transition.
- A TenantAppInvitationGrant links a pending, hashed-token TenantInvitation to eligible OAuthApplication IDs. Invitation roles remain [] and acceptance creates a role-free membership plus consumer/grants atomically. No role is silently assigned.
- An OIDC callback derives identity exclusively from a verified ZITADEL signature and immutable user.id, resolves a single matching UserIdentity issuer+subject and tenant project+OAuthApplication clientId, validates active User and membership, and checks enabled grants. Never accept email, clientId or tenant from unsignatured user fields as authorization.
- Existing RP operators must not experience silent lockout. During global issuer activation, role-bearing regular RP members retain their historical ZITADEL tenant project permissions; registered RP tenant applications still require an active RP membership and a matching tenant/issuer/project. Previously registered external OAuth/MCP Dynamic Client Registration client IDs retain upstream ZITADEL authorization for non-App-Consumer identities. App Consumers always default-deny without a matching explicit client grant; they cannot use the legacy OAuth/MCP fallback.
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

## Extended isolated Actions V2 proof in draft

The existing isolated `tenant-oidc-live-e2e.ts` now includes a second,
independent ZITADEL Actions V2 target that delegates signed webhook bodies to
the production `AppConsumerActionService` backed by real Prisma
`TenantAppConsumer`, `OAuthApplication` and `TenantAppClientGrant` rows.
It checks both subjects across four OAuth client IDs belonging to two
independent tenant projects (two clients per tenant), an authorized refresh
for each, denial for ungranted clients, grant revocation on a *rotated* refresh
token, suspended membership denial and refusal of the RP native client.
Each negative refresh must be observed at the signed target; a generic 4xx
response is not accepted as proof of authorization enforcement.

The target and credentials live only on the isolated CI host and are detached
before test cleanup. The separate installer implementation provisions a new
target and Docker secret automatically, probes the target API through signed
HTTPS, and activates the execution only after the migrated RP stack is healthy.
The installer regression tests exercise foreign-binding rejection and
automatic rollback detachment; real production upgrade/recovery certification
still requires the release pipeline evidence. Review exact CI run results and
the approved source-to-target database restore before declaring DoD.

## Actions V2 payload function compatibility

ZITADEL v4.17.0 includes `"function": "function/preaccesstoken"` in its
signed Actions V2 request. The execution management API uses the bare name
`preaccesstoken`, but accepting that value as the webhook payload function
rejects real logins. The production callback requires the exact namespaced
identifier; missing, bare or different functions fail closed. This was
identified through the real HTTPS CI integration and regression-tested.

## Production action binding verification (draft)

A set of environment booleans is not proof that a shared ZITADEL project
enforces per-client authorization. Before reconciling *any* App Consumer into
the tenant's upstream `rp.tenant.member` project role, RP reads the live
ZITADEL Actions V2 target (`GET /v2/actions/targets/{id}`) and the complete
execution list (`POST /v2/actions/executions/search`), requiring the following
exact binding:

- `RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID` is the returned target ID.
- `RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL` matches its HTTPS endpoint at
  `/api/app-consumer-actions/preaccesstoken` with no query, fragment or
  embedded credentials.
- The target uses `PAYLOAD_TYPE_JSON`, `restWebhook`, and
  `interruptOnError: true` (not async or noninterrupting execution).
- Its currently returned signing key matches the RP-managed
  `RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY` in constant time. Store it in an
  installer-managed Docker secret and supply the application with
  `RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY_FILE`, not logs or command lines.
- Exactly one discovered `preaccesstoken` function execution calls only
  the expected target. Incomplete pagination, multiple targets, absent
  execution, wrong signing key or upstream errors block reconciliation.

For **installer-managed first-time provisioning and rollback** (issue #419),
ZITADEL v4.17.0 can report an empty Actions V2 search using
`{"pagination":{"appliedLimit":"100"}}`: both `executions` and
`pagination.totalResult` are absent. The installer recognizes this as
**no execution** only after a successful HTTPS management request and
a complete applied limit of 100. A concrete list must carry a matching
nonnegative result count; partial fields, malformed conditions, pagination
inconsistencies, HTTP 401/403/5xx and timeouts still fail closed.
This is a pre-activation absence check, **not** certification of an active
authorization binding: the independent read-only grant verifier above still
requires exactly one RP-owned `preaccesstoken` execution.
Regression coverage also exercises `rp_upgrade_apply` from source
v0.2.146 with this sparse response, and preserves the existing
rollback-before-old-stack ordering on a later activation failure.
An isolated test with mocked API replies is not a substitute for the
signed release's real ZITADEL/Swarm and upgrade-source certification.

The ZITADEL management token must have read access to Actions targets and
executions (`action.target.read`, `action.execution.read`), besides the
usual tenant-project management permissions. No production target is created
or changed by this verifier, and both feature flags still default to off.

**Important operational limitation:** the activation-time check alone cannot
protect previously granted roles if the remote execution later disappears.
The API's periodic safety monitor now checks the live binding when tracked
App Consumer project grants exist. On invalid binding, missing flags or a
changed signing key, it first persists `NeedsReconciliation` and
`APP_CONSUMER_ACTION_BINDING_LOST`, then revokes only tracked App Consumer
upstream project roles under the tenant lock; ordinary RP operators keep
their grants. Each successful tenant revocation is recorded in tenant audit
history without subject, client or token contents. Failed upstream revocations
remain tracked for retry and are never falsely reported as complete.

The monitor runs at application startup and on the configured tenant OIDC
reconcile interval (default 60 seconds), even with automatic OIDC rollout
disabled. It is not an instantaneous guarantee: removing the external
execution between checks creates a bounded but nonzero detection window; an
outage of ZITADEL management can delay role revocation. This is a residual
operational risk and must be disclosed. Live production cutover/recovery, HTTPS callback reachability in the
deployment network, and source-to-target database restore certification must
still pass the real release gate. An isolated CI probe alone is not release DoD.

## Native ResourcePortal Web and CLI sign-in

The issuer-global `preaccesstoken` callback has two explicitly configured
first-party RP clients: `OIDC_CLIENT_ID` (Web) and `OIDC_CLI_CLIENT_ID`
(native CLI). It checks the exact signed ZITADEL subject through the RP
identity boundary and permits neither client to an App Consumer. A missing,
pending or unrelated client ID never enters this exemption. The exception
does not grant new tenant OAuth application access. Separately registered MCP Dynamic Client Registration clients are **not**
part of this two-ID exemption. Instead, the callback distinguishes exact
RP-managed tenant OAuthApplication client IDs from pre-existing externally
managed clients: existing non-App-Consumer identities retain the upstream
ZITADEL authorization model; App Consumers cannot use that fallback. The
real HTTPS legacy-client and recovery regression remains a release gate.

## Automatic production installer enrollment and controlled rollback

**User-facing update contract:** normal installation and a supported one-click
ResourcePortal update must deliver App Consumer authorization without any
additional configuration, UI enable/disable switch or ZITADEL setup step.
The installer owns the internal key, target and execution lifecycle.

For a signed release manifest declaring
`apiCapabilities.appConsumerActionsV2Callback=true`, the installer:
1. Verifies there is no foreign/ambiguous global `preaccesstoken` execution.
   An existing RP-owned execution must match the signed callback, key and
   immutable Swarm secret exactly; it is reused unchanged on later updates.
2. Creates a signed JSON `restWebhook` target with
   `interruptOnError=true` and stores the HMAC key in a versioned Swarm
   secret. It does **not** yet attach the global token execution.
3. Deploys the migrated RP API with the signing key mounted only into that
   API. Once RP HTTPS health passes, it probes a validly
   signed request for an invalid subject through the real public HTTPS
   callback and requires an explicit **403**. A 401, 503, 200 or TLS failure
   blocks activation.
4. Attaches only the exact RP target to the global execution and validates
   the binding **before** waiting for tenant OIDC reconciliation. Some
   active tenants require this very binding to complete reconciliation, so
   waiting for readiness first would create a dependency cycle. Stores the
   local target ID and immutable secret reference on successful update.
5. If upgrade fails, it restores the source ZITADEL and RP database
   snapshots, then checks/removes the newly introduced execution before
   attempting to start the previous API image. If DB restore itself
   already removed the target, the absence of a global execution is the
   verified safe state. A foreign or ambiguous execution is never rewritten.

The internal `RP_CFG_APP_CONSUMER_ACTIONS_V2_*` values are *not* new UI
settings. Their consistency is checked before all future updates; an
unexpected modification fails closed. The older manual verifier helper is
retained for diagnostics, not as a required update step.

Issuer-global webhook loss can still temporarily interrupt token issuance
until fail-safe remediation. Production acceptance therefore requires the
live issuer/OAuth/MCP and two-DB restore checks, not merely green unit tests.

### Upgrade preflight: preserve source callback before any mutation

When an App Consumer action has been explicitly certified and enabled,
`rp_upgrade_preflight` and the independently callable `rp_upgrade_apply`
both verify the rollback source **before pulling images, quiescing services
or writing migration checkpoints**. Both source and target must carry the explicit
`apiCapabilities.appConsumerActionsV2Callback=true` contract in their
official signed release manifests. The installed source manifest is
re-attested and its version must match the live source; older source
releases cannot gain compatibility merely because they have a higher
version number. The persisted previous Swarm stack must contain exactly
one enabled and certified API callback, the configured target ID,
canonical HTTPS callback URL and
`_FILE`-based signing secret mount with the same immutable Swarm reference.
The signing Docker secret must still exist; its content is neither read nor
logged by this preflight. A missing, older, mismatched or symlinked previous
stack, stale target ID, wrong key reference or inconsistent installer config
blocks the update. If the feature is off and there is no action configuration
in the source stack, ordinary upgrades need no additional Docker secret.

This protects the source rollback contract and checks the target's signed
compatibility declaration. The automatic issuer detach is additionally tested
by dedicated installer regression; the real protected release still must
verify restore and live issuer availability. Never treat the manifest
contract alone as completed issuer-global lifecycle certification.

### Issuer-global target outage and recovery test (draft)

The isolated real HTTPS ZITADEL suite now simulates a temporary HTTP 503 from
an otherwise correctly signed and bound `preaccesstoken` target. It asserts
that a user entitled to the exact OAuth client **cannot refresh** during this
outage; the denial must be observed at the signed webhook. After restoring
the listener it repeats the OAuth Authorization Code + PKCE flow and verifies
fresh authorized refresh succeeds. This validates the failure behavior but
does not make it acceptable for a production installer to bind or leave the
global Action installed during rollback: issuer-wide authentication disruption
remains a mandatory deployment safety gate.

### Evidence from isolated release readiness

The protected #407 candidate run 42387470756 tested source `v0.2.146`
against the generated merge-group candidate. It applied
`20261107090000_app_consumer_entitlements`, injected an upgrade health
failure, restored RP and ZITADEL databases and the previous API/images,
and verified previous-version Prisma reads/writes. The result was
`rollbackPolicy: tested` with real-upgrade-and-restore evidence. Isolated
HTTPS run 42387470721 also completed successfully with the actual target
readback and a two-user/two-client-per-tenant/two-tenant signed authorization
matrix. These are **source- and run-specific** certifications, not proof of
every supported older source release or of production readiness.


### Review findings and PR merge safety (P1)

The global token callback preserves existing **platform OAuth applications**
(`OAuthApplication.tenantId=null`) for ordinary RP users; only tenant-owned
OAuth clients use exact tenant entitlements. App Consumers retain their
no-RP-login and no-unassigned-client boundaries.

The host installer does not require Node.js. The signed negative callback
probe uses the digest-pinned API image's Node runtime inside a read-only,
network-disabled, no-capabilities ephemeral Docker container. The key stays
in a protected bind-mounted temp directory and is never an argument.

Before protected merge, `Required release readiness` must independently
verify that the PR is not Draft, that Codex has completed a code review for
the exact current PR head SHA without outstanding findings, and that every
GitHub review thread is resolved. The same check runs on `pull_request`
and `merge_group`; pending review blocks the merge-group required check.
