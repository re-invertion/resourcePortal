# Tenant MCP OAuth resource binding — issue #442 (unreleased)

Status: **Draft design and implementation; do not merge or enable until the security
and database rollback gates below are independently certified.** This work
extends PR #443. It is not evidence that production ChatGPT linking works.

## Why a separate resource OAuth issuer

ZITADEL DCR dynamically registered clients currently share project audiences;
the `resource` parameter to its authorization code flow is ignored. Thus a
ZITADEL JWT's DCR project `aud` is not proof of tenant-specific authorization.
A simple membership check is insufficient when the *same* user is permitted in
multiple tenants. See the official ZITADEL DCR limitations.

RP therefore implements a separate OAuth authorization server for tenant MCP
only: issuer `https://<RP_PUBLIC_API_ORIGIN>/api/mcp/oauth`, with OAuth 2
authorization code + PKCE S256, DCR restricted to ChatGPT callback URLs, and
explicit user consent based on either a signed RP Web login session or a
short-lived tenant-specific identity-only session. Users with MCP access but
without a native RP Web grant authenticate using a separate per-tenant
ZITADEL DCR OIDC client; the issuer-global Action verifies its exact saved
client ID, the signed user subject, active tenant membership, SSO role,
MCP allow-list and enabled MCP. The resulting ZITADEL ID token is verified
against the upstream client, nonce, signed issuer, and existing linked user
without creating an RP Web session or changing native grants. Issuer metadata
advertises RFC 9207 authorization response identification and the callback
always returns the exact `iss`, including after a denied consent, so ChatGPT
can use its stable callback without an OAuth mix-up. The existing ZITADEL
login remains the authentication source for the RP user session, but its JWT is
**never accepted as the new tenant MCP resource token**.

The public issuer discovery at
`/.well-known/oauth-authorization-server/api/mcp/oauth` is routed through the
production Web proxy to the API, not HTML/SSR. The per-tenant upstream
ZITADEL code exchange retains the short-lived access token **only** within
the RP server-side callback to query UserInfo if the signed ID token omits
`email_verified`; RP checks the signed issuer/client/nonce first and requires
the UserInfo subject to match the ID token. Neither token is persisted as an
RP Web session or returned to ChatGPT. A later native-only policy cutover
immediately rejects opaque MCP grants from external identity providers,
including refresh, consent and protected resource requests.

The RP authorization server creates cryptographically random opaque access
and refresh tokens; PostgreSQL stores only SHA-256 hashes with the exact
canonical tenant MCP `resource` URI, user, client, expiry and revocation state.
The token verifier uses the resource URI plus tenant ID as mandatory checks;
a token for tenant A is denied for tenant B **even if the same user is a member
of both**. At execution time, RP separately checks active membership, SSO role,
MCP allow-list, tenant IdP policy and tool-level RBAC. Refresh rotates tokens, cannot retarget a different resource, and
re-evaluates current entitlements. Each spent refresh-token SHA-256 hash is
persisted transactionally in `McpOAuthSpentRefreshToken` with a foreign key
to the grant; reuse of an already-rotated token revokes the **entire current
grant** (all successor access and refresh tokens), including simultaneous
competing refresh attempts. Revocation using a spent token also disconnects
the grant. Consumed-token history is cascade-deleted when the parent grant
is deleted; periodic expired-grant cleanup is a separate operational lifecycle
concern.
The consent form requires signed, single-use, short-lived server-side state,
double-submit CSRF protection, and a constant-time checked displayed
`consent_nonce` binding the **specific** tenant/client/PKCE transaction to
the signed pending cookie. Opening another OAuth flow in a separate browser
tab can no longer substitute the grant behind a previously displayed form.

The new issuer is gated by `RP_MCP_RESOURCE_OAUTH_ENABLED`. The production
stack uses **auto**: enable only where the separately certified, issuer-global
ZITADEL Actions V2 pre-token authorization target is already enabled. On
installations without that target, remain disabled and preserve legacy OAuth
behavior; manual `true` still requires strict startup validation. Tenant
protected-resource metadata only advertises it when actually enabled.
Existing ZITADEL tokens are not silently
upgraded or reinterpreted; ChatGPT connections must be reconnected to the new
issuer after a certified cutover.

## Hard release prerequisites

1. Certify both additive Prisma migrations
   `20261114002000_mcp_resource_oauth` and
   `20261114011000_mcp_refresh_replay_lineage`
   against a disposable copy of the immediately preceding *official* RP
   PostgreSQL and ZITADEL event-store databases. Demonstrate a real
   previous-release → exact candidate → injected failure → previous-release
   **two-database rollback and API/ZITADEL read/write recovery** on the
   exact commit/run. Record immutable evidence; never ship an unverified
   schema-changing Fast Fix. The current release policy explicitly blocks
   schema changes absent this certification.
2. Verify a full network-level OAuth flow using **actual ChatGPT**: protected
   resource metadata, issuer discovery, DCR, sign-in, user consent, code+PKCE,
   token, refresh, revoke/disconnect and new connection. Exercise the new
   identity-only ZITADEL client with a user having `sso-login` and MCP but
   **no** native RP Web grant. Local signed-ID-token/nonce, browser-cookie,
   webhook, and PKCE regression tests pass; live ChatGPT/ZITADEL behavior
   remains unproven until the issuer-backed E2E run.
3. Test user belonging to two active tenants A and B: token minted after
   consent for A must be refused for B; verify tenant MCP disabled, selected
   member revoked, `sso-login` revoked, and privileged/write tools forbidden
   without permission. Repeat after refresh and consent revocation.
4. Capture the exact production `client_id` and refusal reason for original
   OAuth callback 403 (request ID
   `f0d90593-dc6b-49a3-8d00-6926684b73d9`). Do not infer it from a mock
   or an HTTP status alone.
5. Validate production canonical `PUBLIC_API_URL`, secure session cookies,
   RP OAuth frontend callback, and OAuth form-body handling behind the same
   public reverse-proxy chain as the supported deployment.
6. Pass full monorepo lint/test/build/installer/CLI, Fast Fix path/profile,
   exact-SHA Codex/security review, protected Release Readiness, Merge Queue,
   signed publication and real source→target restore certificate. **No manual
   tag, direct push, skipped review or release bypass.**

## Deployment and rollback boundaries

Do not enable `RP_MCP_RESOURCE_OAUTH_ENABLED` until the immediately preceding
release's database restoration has been independently demonstrated. Activation
cuts over tenant MCP only; RP Web and CLI OIDC remain unchanged, and the
Platform Admin MCP issuer is distinct. On failure, stop new authorization,
restore previous release and databases using the *certified* procedure, and
confirm previous RP and ZITADEL readiness. Simply setting the feature flag
to false is **not a proven rollback of a database migration** and must not
be counted as release certification.

Expired grants, consent records and registration records require an explicit
lifecycle/retention policy before production scale-up; in the draft design,
these remain rows in PostgreSQL until user/client deletion or an operational
cleanup is implemented.

## DCR uncertain registration and orphan reconciliation (#213)

A `DCR_REGISTRATION_OUTCOME_UNCERTAIN` response means an upstream POST may have
created a ZITADEL DCR client without returning usable cleanup credentials.
**Never retry the registration automatically.** A `DCR_PARTIAL_REGISTRATION`
response means an identified upstream client was created but compensating DELETE
was not confirmed; its `clientId` is a reconciliation locator, **not** evidence
that the application still exists or has been safely removed. Neither result
counts as a successful registration, successful cleanup, or release rollback test.

1. Restrict the procedure to an authorized operator and the **isolated sandbox**
   for release validation; do not mutate production ZITADEL or RP data as part
   of this PR. Preserve sanitized UTC time, instance/issuer host, request ID,
   failure code, deployment SHA, and (only when explicitly present) client ID.
   Never copy registration tokens, authorization headers, OAuth codes, URL query
   strings or credentials into artifacts, tickets or logs.
2. Using an authorized **read-only** ZITADEL management session, identify the
   exact `ZITADEL DCR` project. Perform a bounded, fully paginated project-app
   search, comparing exact client IDs and independently verifying application
   identity; do not accept an incomplete page or ambiguous results as proof of
   absence. A failed management API call is `UNKNOWN`, not an empty result.
3. For a known partial client, compare the returned `clientId` to the exact
   upstream app. If exactly one app exists, obtain **separate explicit
   authorization** before any deletion and use only the authenticated issuer's
   supported management or registration deletion mechanism. Registration
   metadata is untrusted: validate issuer host and expected DCR path and never
   forward a bearer to a returned URL or across a redirect. A failed/unknown
   DELETE result must be independently rechecked before declaring success.
4. For an uncertain registration without a client ID, bound the search to the
   incident UTC window and available sanitized metadata; never guess a client
   from a matching display name alone or bulk-delete matching applications.
   Escalate ambiguous/missing correlation for manual investigation. A clean
   search of an unambiguously identified project and complete result set is
   evidence only for that snapshot, not proof that an earlier POST was never
   accepted in a delayed projection.
5. Before a retry, confirm eventual consistency and search the entire DCR
   project again, recording zero matching orphaned app IDs or a verified
   deletion of the exact app, along with status, UTC and independently audited
   operator authorization. Never claim a real RP/ZITADEL database/eventstore
   rollback PASS from these DCR-specific tests.

The synthetic loopback HTTP tests cover hung initial POST, HTTP 201 headers
with a stalled body, dropped responses, upstream 307 redirects, management
errors/body stalls, and both acknowledged and unacknowledged compensating
DELETEs. The separate sandbox evidence demonstrates one real ZITADEL
POST201 -> management401 -> RP DELETE204 -> independently verified zero-apps
case. **An unknown-response orphan in real ZITADEL has not been reconciled end
to end**, so #213 and the full release acceptance gate remain open.

## MCP identity-only upstream DCR partial state (#442)

The dedicated identity-only MCP ZITADEL client is **separate** from the generic
DCR compatibility registration above. An HTTP 201 accepted upstream
registration followed by an unreadable/invalid response is classified as
`MCP_IDENTITY_DCR_REGISTRATION_OUTCOME_UNCERTAIN`. A valid HTTP 201 followed
by an unsuccessful local `mcpOAuthUpstreamClient` insert, including a
concurrent-first-connect uniqueness race, is classified as
`MCP_IDENTITY_DCR_PARTIAL_REGISTRATION` with a bounded numeric `clientId`.
This is a **potential orphan** even if another concurrent request bound its
own client successfully. Never report the losing transaction as a successful
new connection, automatically retry the non-idempotent DCR POST or silently
use the race winner as proof that the extra ZITADEL app was cleaned up.

Use a read-only-first, separately authorized operator reconciliation:
identify the exact tenant and authenticated issuer/project, compare the
read-only RP `mcpOAuthUpstreamClient` binding with the entire paginated ZITADEL
DCR application list, and independently establish which distinct numeric
client ID was registered by the failed request. No deletion can be inferred
from a conflicting RP uniqueness constraint, nor from an invalid HTTP body.
Do not delete an app while its ownership is ambiguous, particularly when an
existing client is in use for another pending consent. Require a separate
explicit operator authorization for an exact-client deletion and verify the
post-deletion project inventory independently. Do not store bearer tokens,
registration secrets, callback URL query strings or PKCE materials in logs.

These changes classify a failure and prevent a **false-success** result;
they do **not** automatically clean up an orphan, do not establish a live
ZITADEL unknown-response reconciliation, and are not evidence of a real
RP/ZITADEL eventstore/database release rollback. Both #442 and #213 retain
those outstanding acceptance criteria.
