# Tenant OIDC authorization-code failure: evidence and response (#498)

## Status and known evidence

The 2026-11-20 incident involved fresh authorization codes returned to an OAuth2 proxy that failed redemption at the platform-managed ZITADEL token endpoint (`invalid_request`, `Errors.AuthRequest.NotFound`). Three new browser callbacks failed. The original ZITADEL server request logs, correlated token POST metadata, and original client request metadata have not been retained in this repository. **The root cause is not established.** This document is not a certification of the production issuer.

An isolated GitHub Actions real HTTPS E2E with pinned ZITADEL v4.17.0, browser-driven confidential Web + PKCE S256 and signed JWT verification proves that this candidate supports multiple *fresh* successful code exchanges and two independent tenant projects. Green isolated tests cannot establish why an earlier production request disappeared or prove that all production clients work.

## Security boundary

Never copy authorization codes, callback query strings, `state`, PKCE verifiers, client secrets, Basic/Bearer headers, cookies, raw access/ID/refresh tokens, or plaintext session records into tickets, CI artifacts, metrics or operator consoles. A URL containing a query string is confidential even when the path looks like an innocuous callback. Do not enable broad HTTP body logging to investigate this incident.

## Incident capture procedure (read-only)

1. Confirm the exact UTC window, ZITADEL deployment/version/restart timeline, ingress route and hostname, shared PostgreSQL instance, and clock synchronization. Record only sanitized version digests and timestamps.
2. From restricted server-side access, correlate ZITADEL structured event fields for the same flow: **request.id, TraceID, instance ID, UTC time, HTTP method and PATH ONLY (no query), response status, internal error code and duration** at authorize, login completion/callback creation and token issuance. Determine whether the auth request was created, finalized and visible when token redemption occurred. Cross-check any restarts, failed migrations or event-store errors in the same UTC window.
3. Compare the RP-registered client's immutable metadata with the actual confidential-client configuration, exact redirect URI **using a boolean comparison rather than copying its value**, authentication method, PKCE S256 requirement and issuer host. Compare metadata at both sides; do not expose POST parameters or secrets. Explicitly check whether code redemption was accidentally attempted twice.
4. Establish a causally linked failure (not only matching timestamps). Identify the exact component and lifecycle transition where authorization-request state became unavailable. If the upstream state was missing, confirm why; if the request was invalid, identify the mismatched field without disclosing its value.
5. Verify the correction in an isolated, pinned HTTPS issuer using multiple new Web/confidential PKCE logins and distinct clients in each of two tenants. Verify signed ID/access JWT claims and refresh/revoke, cross-tenant denial, and known malformed/expired/replayed-code responses. Preserve sanitized job IDs and immutable commits.
6. Separately repeat a production-safe, non-mutating observation of issuer health and error-rate telemetry. **Production success must not be inferred from discovery HTTP 200, readiness Active or the isolated E2E.** User-facing reconnect tests must be authorized and must not alter existing application grants.

## Result classification

- `OIDC_AUTH_REQUEST_NOT_FOUND`: upstream returned the known request-missing signature; report this as an authorization-code redemption failure and start a fresh login, without automatically retrying/replaying a one-time code.
- `OIDC_TOKEN_EXCHANGE_DENIED`: the token endpoint denied the request for another reason; avoid logging raw provider response.
- `MCP_IDENTITY_AUTH_REQUEST_NOT_FOUND`: same failure encountered by RP's own MCP identity callback; RP returns a safe classified `401`, and consumed local OAuth state cannot be replayed.
- Unknown failure or missing correlation: retain the issue as **unverified**, never label it fixed on the basis of a green health check.

## Release acceptance

Do not close #498 until a production-causality RCA and client compatibility evidence are attached. Do not close #286 until its independent MFA/recovery, RP Web/CLI integration and migration prerequisites are certified. Do not close #442 solely because a previously connected MCP client can invoke tools: fresh ChatGPT reconnect and negative RBAC/tenant/refresh cases remain necessary. Release certification additionally requires the exact main commit, protected CI/merge queue, signed direct tag and real RP/ZITADEL automatic rollback evidence; no production rollout is part of this process.
