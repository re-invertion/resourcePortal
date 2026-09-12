# Resource Portal CLI Browser Login via OAuth Device Authorization

Date: 2026-09-12
Status: Proposed / approved at high level, pending written-spec review

## Goal

Replace the normal manual bearer-token workflow for `rp login` with an interactive browser login.

The target user experience is:

```text
rp login --api-url https://portal.resource-portal.pl/api
        ↓
CLI starts OAuth Device Authorization
        ↓
CLI opens the verification URL in the user's browser
        ↓
user signs in through ZITADEL and approves the request
        ↓
CLI receives a Resource Portal-compatible bearer token
        ↓
CLI verifies the token against Resource Portal and stores it locally
        ↓
rp tenant list
```

A user must not need to manually create a Service Identity, copy a `clientId`, copy a `clientSecret`, exchange credentials with `curl`/PowerShell, or paste an access token into `rp login`.

The existing `--token` and `--dev-user-id` modes remain available for backward compatibility and development, but browser/device login becomes the default production login path.

## Chosen approach

Use OAuth 2.0 Device Authorization Grant (RFC 8628) with a dedicated public ZITADEL application for Resource Portal CLI.

Reasons:

- ZITADEL supports RFC 8628 directly and documents CLI as an intended use case.
- The CLI is a public client and therefore must not ship or store a client secret.
- No local callback listener, fixed localhost port, custom URI handler, or firewall exception is required.
- ZITADEL returns `verification_uri_complete`, allowing the CLI to open a browser directly with the user code pre-filled.
- Authentication remains entirely owned by ZITADEL, including password, SSO, MFA, passkeys, and future identity-provider changes.
- Resource Portal does not invent a custom token-broker protocol.

Reference behavior follows ZITADEL's documented RFC 8628 device authorization flow:

- device authorization endpoint: discovered through OIDC metadata,
- token endpoint: discovered through OIDC metadata,
- grant type for polling: `urn:ietf:params:oauth:grant-type:device_code`,
- public client: client ID only, no client secret.

## Non-goals

This change does not:

- replace the normal Resource Portal browser session flow,
- remove Service Identities or machine-to-machine authentication,
- make `--token` invalid,
- require the CLI to store a client secret,
- introduce a Resource Portal-specific password prompt,
- expose ZITADEL management credentials to the CLI,
- use a Resource Owner Password Credentials flow,
- make interactive authentication suitable for CI/CD; CI/CD should continue using Service Identities.

## Authentication model

Resource Portal will have two different ZITADEL application/client purposes:

```text
Resource Portal Web
  confidential web client
  Authorization Code + PKCE
  browser session managed by Resource Portal API

Resource Portal CLI
  public/native client
  Device Authorization Grant
  no client secret
  bearer token used directly against Resource Portal API
```

The CLI client belongs to the same Resource Portal ZITADEL project as the web client. Its access token must carry the Resource Portal project audience so the existing API audience verification can accept it.

The CLI requests scopes sufficient to identify the user and target the Resource Portal API project. The server publishes the exact scopes rather than duplicating project/organization IDs in the CLI.

Expected server-derived scope set is conceptually:

```text
openid
profile
email
urn:zitadel:iam:org:project:id:<resource-portal-project-id>:aud
urn:zitadel:iam:org:id:<resource-portal-organization-id>
```

`offline_access` is not a hard requirement for this design. ZITADEL documents `offline_access`/refresh-token behavior primarily for code flow, so the CLI must not depend on Device Authorization returning a refresh token. If ZITADEL returns a refresh token for the configured client, the CLI may store and use it; otherwise token expiry requires another `rp login`, still without any manual token handling.

## Public CLI authentication configuration endpoint

Add a public, read-only endpoint:

```text
GET /api/auth/cli-config
```

Example response:

```json
{
  "issuer": "https://auth.portal.resource-portal.pl",
  "clientId": "<public-cli-client-id>",
  "scopes": [
    "openid",
    "profile",
    "email",
    "urn:zitadel:iam:org:project:id:390305435971748110:aud",
    "urn:zitadel:iam:org:id:<organization-id>"
  ]
}
```

This endpoint contains no secret material.

The CLI uses `issuer` to fetch `/.well-known/openid-configuration` and obtains the actual `device_authorization_endpoint`, `token_endpoint`, and optional `revocation_endpoint` from OIDC discovery.

The endpoint is the stable Resource Portal contract. The CLI must not assume that the authentication domain is derived from the Resource Portal API hostname.

If CLI authentication is not configured, the endpoint returns a service-unavailable style error instead of an incomplete configuration.

## Installer and ZITADEL provisioning

### Fresh installation

The production identity bootstrap must create or find a dedicated ZITADEL OIDC application named consistently, e.g. `Resource Portal CLI`.

Required properties:

- public/native application,
- no client secret,
- Device Authorization grant enabled,
- JWT access tokens,
- Resource Portal project ownership,
- idempotent provisioning.

The exact ZITADEL management-API enum/value names must be taken from the currently pinned/supported ZITADEL API, not guessed. The integration test is the source of truth that the generated client can start Device Authorization.

The bootstrap output should persist the CLI client ID as non-secret metadata, preferably through an explicit sidecar such as:

```text
zitadel-bootstrap.json.cli-client-id
```

or another naming convention consistent with the existing bootstrap sidecars.

The installer persists the value in its normal configuration state, for example:

```text
RP_CFG_OIDC_CLI_CLIENT_ID=<client-id>
```

The rendered production API service receives:

```text
OIDC_CLI_CLIENT_ID=<client-id>
```

No CLI client secret exists or is rendered.

### Existing installations / upgrade

Upgrade must work for installations created before this feature.

If the persisted installer configuration lacks a CLI client ID, upgrade/repair must run an idempotent ZITADEL provisioning step using the already secured ZITADEL management credential and persisted organization/project metadata.

That provisioning step must:

1. find an existing Resource Portal CLI application if one already exists,
2. create it if missing,
3. return/persist only the public client ID,
4. update installer state before rendering the final stack.

It must not require a full destructive identity bootstrap or reset existing web-login credentials.

`upgrade`, `repair`, `reconfigure`, resume flows, and repeated final stack deploys must preserve the CLI client configuration.

## Resource Portal API bearer-token handling

### Existing issue

The current API bearer-token path verifies a JWT and, for a non-Service-Identity subject, attempts to create/find a user using claims directly from the bearer token.

ZITADEL documents that standard user claims such as `email` are not asserted in JWT access tokens. They are available from the OIDC UserInfo endpoint. Therefore a valid human access token obtained through Device Authorization can pass signature/audience verification but still fail Resource Portal user resolution because `email` is absent.

### Required change

Keep Service Identity authentication unchanged.

For a verified bearer token whose `sub` does not map to a Resource Portal Service Identity:

1. verify issuer, signature, expiry, and audience exactly as today,
2. obtain the subject (`sub`) from the verified access token,
3. if the token already has sufficient user claims, they may be used,
4. otherwise call the discovered OIDC `userinfo_endpoint` with the same bearer access token,
5. require the returned `sub` to exactly match the verified token subject,
6. use the UserInfo claims (`email`, `email_verified`, name/profile fields) for existing Resource Portal user linking/provisioning,
7. apply the existing user status and RBAC rules.

The UserInfo response must never be trusted without the access token first passing normal JWT verification and audience validation.

This makes human OAuth access tokens standards-compatible without changing Service Identity behavior.

## CLI command behavior

### Default login

New default:

```text
rp login --api-url https://portal.resource-portal.pl/api
```

Flow:

1. Normalize the API URL.
2. Fetch `GET /auth/cli-config` relative to the configured API base.
3. Fetch OIDC discovery from the returned issuer.
4. Require `device_authorization_endpoint` and `token_endpoint`.
5. POST device authorization request containing `client_id` and the published scopes.
6. Parse at least:
   - `device_code`,
   - `user_code`,
   - `verification_uri`,
   - optional `verification_uri_complete`,
   - `expires_in`,
   - `interval`.
7. Print the verification URL and user code even if automatic browser opening succeeds.
8. Attempt to open `verification_uri_complete` when provided, otherwise `verification_uri`.
9. Poll the token endpoint according to RFC 8628.
10. Respect `authorization_pending`, `slow_down`, `access_denied`, and expiry.
11. On success, obtain `access_token`, `token_type`, and `expires_in`; accept optional `refresh_token` if returned.
12. Verify the resulting token by making an authenticated Resource Portal request such as `account show` before writing `LoggedIn` state.
13. Persist credentials only after Resource Portal accepts the token.
14. Print a concise success result.

The old behavior where `rp login` stores an arbitrary token without validation must no longer be the behavior of the interactive flow.

### Browser opening

Browser launch is best-effort and cross-platform:

- Windows: use the platform shell/open mechanism,
- macOS: `open`,
- Linux: `xdg-open` when available.

Failure to open a browser is not fatal. The CLI has already printed the URL and user code and continues polling.

No browser-opening dependency is required unless the standard-library implementation becomes materially less reliable than a small maintained dependency.

### Manual token mode

Backward compatibility remains:

```text
rp login --api-url URL --token TOKEN
```

Manual token login should validate the token against Resource Portal before saving it. A rejected token must not produce `LoggedIn`.

Environment override behavior remains:

```text
RESOURCE_PORTAL_TOKEN
```

An environment token takes precedence over stored credentials for the current process and is not overwritten by automatic refresh logic.

### Development mode

Existing development authentication remains:

```text
rp login --api-url URL --dev-user-id USER_ID
```

It must remain clearly separate from production OAuth login.

## Local CLI credential storage

Keep using the existing per-user configuration location:

```text
~/.resourceportal/config.json
```

Backward-compatible fields remain readable:

```json
{
  "apiUrl": "...",
  "token": "...",
  "devUserId": "..."
}
```

Interactive login may extend the config with authentication metadata, e.g.:

```json
{
  "apiUrl": "https://portal.resource-portal.pl/api",
  "token": "<access-token>",
  "auth": {
    "mode": "device",
    "issuer": "https://auth.portal.resource-portal.pl",
    "clientId": "<client-id>",
    "expiresAt": "2026-09-13T07:00:00.000Z",
    "tokenEndpoint": "https://auth.portal.resource-portal.pl/oauth/v2/token",
    "revocationEndpoint": "https://auth.portal.resource-portal.pl/oauth/v2/revoke",
    "refreshToken": "<optional>"
  }
}
```

The config file remains mode `0600` where POSIX permissions are available. On Windows it remains under the current user's profile and uses the platform's normal per-user profile ACL behavior.

This feature does not introduce an OS keychain dependency. Moving long-lived credentials to Credential Manager/Keychain/libsecret can be a later hardening feature.

Manual-token login should replace/remove stale device-flow metadata. Device-flow login should replace stale manual credentials. `dev-user-id` login should not leave a production bearer token active.

## Token lifetime and optional refresh

The CLI must not assume Device Authorization yields a refresh token.

If the token response includes `refresh_token`:

- store it,
- before executing authenticated commands, refresh when the access token is expired or within a small safety window,
- persist a rotated refresh token if the provider returns one,
- on `invalid_grant` or equivalent, clear unusable refresh state and require a new interactive login.

If no refresh token exists:

- use the access token until expiry,
- do not silently launch an interactive browser from arbitrary commands,
- return a clear error such as `Authentication expired. Run rp login.`

This avoids hanging CI/scripts on an unexpected browser login while still eliminating manual token copy/paste for humans.

## Shared CLI authentication module

The current CLI has duplicated config/token reading across `index.ts`, `full-cli.ts`, and `complete-cli.ts`.

Introduce a small shared module for:

- config path/read/write,
- migration/backward compatibility,
- credential selection precedence,
- optional token refresh,
- device login,
- manual token validation,
- logout/revocation.

All command entry paths must consume the same resolved authentication state so `health`, compatibility commands, and legacy commands cannot drift.

Do not perform unrelated CLI refactors.

## Logout

`rp logout` must always remove local authentication state.

When a revocation endpoint is known, perform best-effort remote revocation before or during logout:

- revoke refresh token first when present,
- otherwise revoke access token when supported,
- identify the public client by client ID as required by the provider.

A network/revocation failure must not prevent local logout. Print a warning and still remove the local credentials.

`rp logout` does not need to terminate unrelated browser Resource Portal sessions.

## Error handling

Expected user-facing errors include:

- Resource Portal does not expose CLI auth configuration,
- OIDC discovery unavailable,
- provider does not advertise Device Authorization,
- browser could not be opened (warning only),
- user denied request,
- device code expired,
- login timed out,
- token endpoint returned malformed data,
- token was issued but Resource Portal rejected it,
- stored token expired and no refresh token is available,
- refresh token rejected.

Error messages must not print access tokens, refresh tokens, device codes beyond what is intentionally shown for the login flow, management tokens, or client secrets.

The CLI must never print the complete stored bearer token in normal table output.

## Security properties

The design must preserve these invariants:

1. Resource Portal CLI has no client secret.
2. ZITADEL management credentials remain server-side only.
3. The user authenticates only on ZITADEL-hosted login pages.
4. The CLI never asks for the user's password.
5. The API validates token signature, issuer, expiry, and Resource Portal audience before using UserInfo.
6. UserInfo `sub` must equal the verified access-token `sub`.
7. Tenant permissions continue to come from Resource Portal membership/role state, not from trusting arbitrary client-side claims.
8. Service Identity authentication remains separate and unchanged.
9. Browser login cannot implicitly grant Platform Administrator privileges.
10. Secrets/tokens are excluded from logs and audit payloads.

## API and installer configuration

Expected new non-secret configuration values:

```text
OIDC_CLI_CLIENT_ID
RP_CFG_OIDC_CLI_CLIENT_ID
```

The API derives/publishes scopes using already persisted server metadata such as:

```text
ZITADEL_PROJECT_ID
ZITADEL_ORGANIZATION_ID
```

Do not duplicate the project ID as a hard-coded CLI constant.

Production stack rendering must fail closed when CLI auth is declared enabled but required client metadata is absent. Upgrade logic is responsible for provisioning missing metadata before final rendering.

## Testing strategy

### CLI unit/integration tests

Use a local fake HTTP server or injectable HTTP/browser adapters to test the complete deterministic protocol without real user interaction.

Required cases:

1. `rp login --api-url URL` fetches CLI config and OIDC discovery.
2. Device authorization request sends correct client ID/scopes.
3. `verification_uri_complete` is preferred when present.
4. Browser-open failure still prints instructions and continues.
5. Polling handles `authorization_pending`.
6. Polling handles `slow_down` by increasing delay.
7. User denial returns a clear error and stores nothing.
8. Expired device code stores nothing.
9. Successful token is validated against RP before persistence.
10. RP rejection after token issuance stores nothing.
11. Manual `--token` login validates before persistence.
12. Existing legacy config remains readable.
13. Environment token overrides stored token.
14. Optional refresh token path refreshes before expiry.
15. No-refresh expiry instructs the user to run `rp login`.
16. Logout clears local state even when remote revocation fails.

### API tests

Required cases:

1. `/api/auth/cli-config` is public and returns no secret data.
2. Missing `OIDC_CLI_CLIENT_ID` produces an explicit configuration error.
3. Published scopes contain the Resource Portal project audience.
4. Existing Service Identity bearer auth remains unchanged.
5. Human JWT access token with no email claim triggers UserInfo lookup.
6. UserInfo subject mismatch is rejected.
7. UserInfo email/profile is used for normal user lookup/provisioning.
8. Invalid JWT never triggers trusted user provisioning.
9. UserInfo failure returns authentication failure without leaking provider details.

### Installer tests

Required cases:

1. Fresh bootstrap provisions both web and CLI clients.
2. CLI client is public and does not generate/persist a client secret.
3. CLI client ID is persisted as non-secret installer metadata.
4. Final API stack receives `OIDC_CLI_CLIENT_ID`.
5. Existing installation upgrade provisions the missing CLI client idempotently.
6. Re-running repair/reconfigure does not create duplicate CLI apps.
7. Reset cleans installer metadata consistently with the rest of identity state.
8. No CLI credential secret appears in Docker Swarm secrets because none should exist.

### Regression tests

Run the existing API, SDK, CLI, installer, and identity suites. Existing web login, Service Identity client-credentials flow, and platform authentication must continue to pass.

## Manual smoke test

After deployment/upgrading a test environment:

```text
rp logout
rp login --api-url https://portal.resource-portal.pl/api
```

Expected behavior:

1. CLI prints a ZITADEL verification URL/code.
2. Default browser opens automatically.
3. User authenticates normally in ZITADEL.
4. User approves the CLI request.
5. CLI prints `LoggedIn` only after Resource Portal accepts the bearer token.

Then:

```text
rp account show
rp tenant list -o json
```

Both must work without copying any token.

Inspect local config only to verify structure; do not paste token values into logs/issues/chat.

For compatibility:

```text
rp login --api-url https://portal.resource-portal.pl/api --token <valid-token>
```

must still work after validating the token.

Service Identity client-credentials authentication must also continue to work for automation.

## Rollout and compatibility

This is additive at the API contract level and backward-compatible at the CLI command-line level.

Existing users with a stored manual token keep working until they choose to run the new `rp login` flow or the token expires.

Existing installations require the installer upgrade path to provision the public CLI app before browser login is advertised as available.

The web application and CLI application must remain separate ZITADEL clients. Do not reuse the confidential web client for the public CLI.

## Acceptance criteria

The feature is complete when all of the following are true:

- `rp login --api-url <url>` requires no token argument.
- The browser opens to a ZITADEL-controlled authentication/approval page.
- No client secret exists in the CLI binary, source config, or user config.
- The CLI obtains and validates a Resource Portal-compatible bearer token.
- `rp tenant list` works immediately after browser login.
- A human JWT access token without email claims is correctly resolved via OIDC UserInfo.
- Service Identity authentication is unaffected.
- `--token` remains backward compatible and is validated before storage.
- Fresh installs provision the CLI client automatically.
- Upgrades from pre-feature installs provision the CLI client automatically and idempotently.
- Login failures never leave a misleading `LoggedIn` configuration.
- No manual token copy/paste is necessary for normal human CLI use.
