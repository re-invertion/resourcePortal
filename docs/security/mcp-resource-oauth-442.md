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
explicit user consent based on a signed RP login session. The existing ZITADEL
login remains the authentication source for the RP user session, but its JWT is
**never accepted as the new tenant MCP resource token**.

The RP authorization server creates cryptographically random opaque access
and refresh tokens; PostgreSQL stores only SHA-256 hashes with the exact
canonical tenant MCP `resource` URI, user, client, expiry and revocation state.
The token verifier uses the resource URI plus tenant ID as mandatory checks;
a token for tenant A is denied for tenant B **even if the same user is a member
of both**. At execution time, RP separately checks active membership, SSO role,
MCP allow-list, tenant IdP policy and tool-level RBAC. Refresh rotates tokens,
cannot retarget a different resource, and re-evaluates current entitlements.
The consent form requires signed, single-use, short-lived server-side state and
double-submit CSRF protection.

The new issuer is gated by `RP_MCP_RESOURCE_OAUTH_ENABLED`, **default false**
in the production stack template. Tenant protected-resource metadata only
advertises it when explicitly enabled. Existing ZITADEL tokens are not silently
upgraded or reinterpreted; ChatGPT connections must be reconnected to the new
issuer after a certified cutover.

## Hard release prerequisites

1. Certify the additive Prisma migration `20261114002000_mcp_resource_oauth`
   against a disposable copy of the immediately preceding *official* RP
   PostgreSQL and ZITADEL event-store databases. Demonstrate a real
   previous-release → exact candidate → injected failure → previous-release
   **two-database rollback and API/ZITADEL read/write recovery** on the
   exact commit/run. Record immutable evidence; never ship an unverified
   schema-changing Fast Fix. The current release policy explicitly blocks
   schema changes absent this certification.
2. Verify a full network-level OAuth flow using **actual ChatGPT**: protected
   resource metadata, issuer discovery, DCR, sign-in, user consent, code+PKCE,
   token, refresh, revoke/disconnect and new connection. Test users with only
   `sso-login` (no RP native Web grant), since the current sign-in path uses
   the RP Web session and may deny MCP-only users. This dependency is a
   **separate outstanding compatibility requirement**, not proof of success.
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
