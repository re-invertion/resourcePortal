# Issue #398 — isolated ZITADEL Actions V2 client-scoped refresh proof

**Status:** Experimental, test-only security contract. This does **not** enable
App Consumer accounts, alter the identity provider in a live RP installation,
or constitute completion of the feature request.

## Why this test is required

A ZITADEL project role allows login to other applications in the same project.
Application-only access therefore needs enforcement at the individual OAuth
client ID on token issuance **and on refresh**, not merely project membership.

ZITADEL Actions V2 documents a function/preaccesstoken request field
application.client_id and supports interruptOnError on REST webhook targets.
Documentation alone is not proof that the pin in RP's test environment
(ZITADEL v4.17.0) rejects refresh with a revoked application entitlement.

## What the isolation test proves when green

On a disposable GitHub Actions runner, with a self-signed HTTPS issuer,
two native test humans and independent tenant projects:

- Registers an ephemeral Actions V2 webhook target with interruptOnError
  and requires the signing key returned by the isolated issuer.
- Verifies each request's HMAC-SHA256 payload signature and a five-minute
  signed timestamp tolerance, not merely the caller's IP or claimed user ID.
- Exercises a second client in the **same tenant project** using real browser
  OIDC Authorization Code + PKCE and real token refresh.
- Denies that exact client and confirms that refresh fails with a verified
  denied callback identifying its client ID and immutable user subject.
- Confirms the initial OAuth client (same user, same project) can still refresh.
- Confirms a distinct test user in a separate tenant project can still log in.
- Cleans up the execution before the normal project-revocation regression;
  the entire issuer and its database are discarded by docker compose down -v.

The test MUST fail if the Actions V2 callback is not called, does not expose
the client ID on refresh, refuses a valid allowed client or returns success
after a denied refresh. This is a blocking test, not a best-effort diagnostic.

## Limits / remaining #398 DoD

- The request-specific action is deliberately **not deployed** to production.
- It does not contain a durable, tenant-scoped authorization grant store,
  invitation/UI flow, account lifecycle or signed production webhook endpoint.
- It doesn't prove the behavior of preuserinfo/ID-token-only paths. These
  need their own tests and may require a different enforcement point.
- The full 2-user x 2-OAuth-client x 2-tenant negative matrix, disabled grants,
  action outage, and application session expiry need explicit certification.
- Database schema changes remain prohibited for normal patch releases until
  the project's DB restore/rollback policy has been certified.

References:
- https://zitadel.com/docs/guides/integrate/actions/usage
- https://zitadel.com/docs/guides/integrate/actions/testing-request-signature
- https://zitadel.com/docs/reference/api/action/zitadel.action.v2.ActionService.CreateTarget
- https://zitadel.com/docs/reference/api/action/zitadel.action.v2.ActionService.SetExecution
