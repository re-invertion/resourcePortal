# Authentication session policy

Resource Portal browser sessions use two independent expiry boundaries:

- `AUTH_SESSION_TTL_SECONDS` is the **absolute session lifetime**. The Stage 1 default is `604800` seconds (7 days). `PortalSession.expiresAt` is set when the RP session is created and is never moved forward by OIDC token refresh.
- `AUTH_SESSION_IDLE_TIMEOUT_SECONDS` is the inactivity boundary. The Stage 1 default is `43200` seconds (12 hours). A session can be revoked before its absolute expiry when `lastSeenAt` exceeds this interval.

OIDC access/refresh token rotation is internal to the fixed RP session window. Refreshing provider tokens updates encrypted token material and provider-token expiry only; it does not extend `PortalSession.expiresAt`.

Expired or idle sessions are rejected during authentication and can be marked revoked by the session-maintenance job. Provider logout/revocation remains separate from the local absolute-lifetime calculation.
