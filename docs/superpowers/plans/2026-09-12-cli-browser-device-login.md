# Resource Portal CLI Browser Device Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `rp login --api-url <url>` perform interactive ZITADEL Device Authorization in the browser, validate the resulting bearer token against Resource Portal, and persist usable credentials without manual token copy/paste.

**Architecture:** Add a dedicated public/native ZITADEL CLI client provisioned by bootstrap/installer, expose its non-secret configuration through `GET /api/auth/cli-config`, extend API bearer auth to resolve human claims through UserInfo, and centralize CLI credential/device-flow logic in a shared auth module consumed by all CLI entry paths. Keep Service Identity client-credentials and manual `--token` login backward-compatible.

**Tech Stack:** TypeScript 5.9, NestJS, Fastify, jose/OIDC discovery, Node.js built-ins (`fetch`, `child_process`, `fs`, `os`), ZITADEL Management API + RFC 8628 Device Authorization, Bash production installer, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-12-cli-browser-device-login-design.md`

## Global Constraints

- `rp login --api-url <url>` must not require a manually supplied token.
- Resource Portal CLI is a public client: no client secret may exist in CLI source, binaries, installer state, Docker secrets, or `~/.resourceportal/config.json`.
- Device Authorization grant is `OIDC_GRANT_TYPE_DEVICE_CODE` in the existing ZITADEL Management API provisioning payload and `urn:ietf:params:oauth:grant-type:device_code` at the token endpoint.
- CLI access tokens must be JWTs and include the Resource Portal project audience.
- Web and CLI ZITADEL applications remain separate.
- Service Identity authentication behavior must remain unchanged.
- Human access tokens must be JWT-verified before UserInfo is trusted; UserInfo `sub` must equal the verified JWT `sub`.
- `--token`, `RESOURCE_PORTAL_TOKEN`, and `--dev-user-id` remain supported.
- `RESOURCE_PORTAL_TOKEN` always overrides stored credentials for the current process and is never auto-refreshed.
- Interactive/browser login must never start implicitly from arbitrary non-login commands.
- Login failures must never persist misleading credentials.
- `rp logout` must clear local auth even if remote revocation fails.
- Existing installations must gain the CLI client through idempotent upgrade/repair/reconfigure logic without destructive identity bootstrap.

---

## File Structure

### New files

- `packages/resourceportal-cli/src/auth.ts` — shared CLI config storage, credential resolution, token refresh, manual-token validation, device-flow protocol, browser launch, logout/revocation.
- `packages/resourceportal-cli/test/auth.test.js` — deterministic fake-server tests for shared auth/device flow.

### Modified API files

- `packages/resourceportal-api/src/auth/oidc-auth.service.ts` — discovery fields and verified-human-token UserInfo fallback.
- `packages/resourceportal-api/src/auth/oidc-auth.service.spec.ts` — UserInfo and Service Identity regression tests.
- `packages/resourceportal-api/src/auth/auth.controller.ts` — public `GET /auth/cli-config` endpoint.
- `packages/resourceportal-api/src/auth/auth.controller.spec.ts` — CLI-config endpoint tests.

### Modified bootstrap/installer files

- `packages/resourceportal-api/scripts/bootstrap-zitadel.ts` — create/find `Resource Portal CLI` native Device Code client and emit `cliClientId` + sidecar.
- `scripts/installer/identity.sh` — ingest/bootstrap and idempotently provision missing CLI client metadata.
- `scripts/installer/config.sh` — persist `RP_CFG_OIDC_CLI_CLIENT_ID`.
- `scripts/installer/control-plane.sh` — require/render CLI client ID.
- `scripts/installer/lifecycle.sh` — preserve/provision CLI client across install/upgrade/repair/reconfigure/resume.
- `scripts/installer/reset.sh` — clean CLI client metadata sidecar/state consistently.
- `config/production/stack.yml.tpl` — pass `OIDC_CLI_CLIENT_ID` to API only.
- `test/installer/test-zitadel-management.sh` — bootstrap/provisioning assertions.
- `test/installer/test-control-plane.sh` — rendered stack assertions.
- `test/installer/test-workflows.sh` — lifecycle/upgrade idempotency assertions.

### Modified CLI files

- `packages/resourceportal-cli/src/index.ts` — route legacy/default login/logout and command auth through shared module.
- `packages/resourceportal-cli/src/full-cli.ts` — consume shared resolved credentials instead of duplicate config parsing.
- `packages/resourceportal-cli/src/complete-cli.ts` — consume shared resolved credentials for compatibility/health paths.
- `packages/resourceportal-cli/README.md` — browser login and automation examples.
- `packages/resourceportal-cli/test/compatibility.test.js` — regression coverage for existing flags/commands.

---

### Task 1: Publish Resource Portal CLI OAuth configuration

**Files:**
- Modify: `packages/resourceportal-api/src/auth/oidc-auth.service.ts`
- Modify: `packages/resourceportal-api/src/auth/auth.controller.ts`
- Test: `packages/resourceportal-api/src/auth/auth.controller.spec.ts`

**Interfaces:**
- Produces: `OidcDiscovery.deviceAuthorizationEndpoint?: string`, `OidcDiscovery.userInfoEndpoint?: string`, `AuthController.cliConfig(): { issuer: string; clientId: string; scopes: string[] }`.
- Consumes later: CLI Task 6 calls `GET /auth/cli-config` and uses the returned issuer/client/scopes.

- [ ] **Step 1: Write failing controller tests for `GET /api/auth/cli-config`**

Add tests equivalent to:

```ts
it("publishes public CLI OAuth configuration without secrets", async () => {
  process.env.OIDC_ISSUER_URL = "https://auth.example.test";
  process.env.OIDC_CLI_CLIENT_ID = "rp-cli-client";
  process.env.ZITADEL_PROJECT_ID = "390305435971748110";
  process.env.ZITADEL_ORGANIZATION_ID = "123456789";

  const response = await app.inject({ method: "GET", url: "/api/auth/cli-config" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    issuer: "https://auth.example.test",
    clientId: "rp-cli-client",
    scopes: [
      "openid",
      "profile",
      "email",
      "urn:zitadel:iam:org:project:id:390305435971748110:aud",
      "urn:zitadel:iam:org:id:123456789",
    ],
  });
  expect(JSON.stringify(response.json())).not.toMatch(/secret/i);
});

it("fails closed when CLI OAuth client is not configured", async () => {
  delete process.env.OIDC_CLI_CLIENT_ID;
  const response = await app.inject({ method: "GET", url: "/api/auth/cli-config" });
  expect(response.statusCode).toBe(503);
});
```

- [ ] **Step 2: Run focused controller tests and verify failure**

Run:

```bash
npm --workspace @resource-portal/api test -- src/auth/auth.controller.spec.ts
```

Expected: FAIL because `/api/auth/cli-config` does not exist.

- [ ] **Step 3: Extend discovery typing and parsing**

In `oidc-auth.service.ts`, extend `OidcDiscovery` and `fetchDiscovery()`:

```ts
export type OidcDiscovery = {
  authorizationEndpoint: string;
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  userInfoEndpoint?: string;
  revocationEndpoint?: string;
  endSessionEndpoint?: string;
};
```

Map `device_authorization_endpoint` and `userinfo_endpoint` exactly like the existing optional revocation/end-session endpoints.

- [ ] **Step 4: Implement the public CLI config endpoint**

Add a `@Public()` controller method that validates all required server metadata:

```ts
@Get("cli-config")
@Public()
cliConfig() {
  const issuer = this.config.get<string>("OIDC_ISSUER_URL")?.replace(/\/$/, "");
  const clientId = this.config.get<string>("OIDC_CLI_CLIENT_ID");
  const projectId = this.config.get<string>("ZITADEL_PROJECT_ID");
  const organizationId = this.config.get<string>("ZITADEL_ORGANIZATION_ID");
  if (!issuer || !clientId || !projectId || !organizationId) {
    throw new ServiceUnavailableException("CLI authentication is not configured");
  }
  return {
    issuer,
    clientId,
    scopes: [
      "openid",
      "profile",
      "email",
      `urn:zitadel:iam:org:project:id:${projectId}:aud`,
      `urn:zitadel:iam:org:id:${organizationId}`,
    ],
  };
}
```

Inject `ConfigService` into `AuthController`; do not expose web-client secrets or management credentials.

- [ ] **Step 5: Run controller tests**

Run:

```bash
npm --workspace @resource-portal/api test -- src/auth/auth.controller.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/resourceportal-api/src/auth/oidc-auth.service.ts packages/resourceportal-api/src/auth/auth.controller.ts packages/resourceportal-api/src/auth/auth.controller.spec.ts
git commit -m "feat(auth): publish CLI OAuth configuration"
```

---

### Task 2: Support human JWT bearer tokens through OIDC UserInfo

**Files:**
- Modify: `packages/resourceportal-api/src/auth/oidc-auth.service.ts`
- Test: `packages/resourceportal-api/src/auth/oidc-auth.service.spec.ts`

**Interfaces:**
- Produces: `authenticatePrincipalToken(token)` keeps Service Identity lookup first, but for human subjects calls `resolveHumanClaims(token, verifiedPayload)` before `findOrProvisionUser`.
- Security invariant: UserInfo is called only after `jwtVerify` succeeds and its `sub` must exactly equal verified JWT `sub`.

- [ ] **Step 1: Add failing UserInfo tests**

Add fixtures/tests for:

```ts
it("uses UserInfo when a verified human access token omits email", async () => {
  // JWT fixture has sub/aud/iss/exp but no email.
  // Discovery advertises userinfo_endpoint.
  // Fake UserInfo returns matching sub + verified email/profile.
  const principal = await service.authenticatePrincipalToken(accessToken);
  expect(principal.type).toBe("User");
  expect(principal.user.email).toBe("patryk@example.test");
});

it("rejects UserInfo subject mismatch", async () => {
  // verified token sub=user-1, UserInfo sub=user-2
  await expect(service.authenticatePrincipalToken(accessToken)).rejects.toThrow(
    "OIDC UserInfo subject mismatch",
  );
});

it("does not call UserInfo for an invalid JWT", async () => {
  await expect(service.authenticatePrincipalToken("bad-token")).rejects.toThrow(
    "OIDC bearer token is invalid",
  );
  expect(userInfoCalls).toBe(0);
});

it("keeps service identity bearer authentication independent of UserInfo", async () => {
  const principal = await service.authenticatePrincipalToken(serviceIdentityJwt);
  expect(principal.type).toBe("ServiceIdentity");
  expect(userInfoCalls).toBe(0);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm --workspace @resource-portal/api test -- src/auth/oidc-auth.service.spec.ts
```

Expected: FAIL on human token without email and UserInfo mismatch cases.

- [ ] **Step 3: Implement verified Human UserInfo resolution**

Introduce helpers with explicit signatures:

```ts
private async resolveHumanClaims(token: string, payload: JWTPayload): Promise<JWTPayload>
private async fetchUserInfo(token: string, expectedSubject: string): Promise<JWTPayload>
```

Behavior:

```ts
private async resolveHumanClaims(token: string, payload: JWTPayload) {
  if (typeof payload.email === "string" && payload.email.length > 0) return payload;
  const subject = this.requireStringClaim(payload.sub, "sub");
  return this.fetchUserInfo(token, subject);
}
```

`fetchUserInfo` must:

```ts
const discovery = await this.getDiscovery();
if (!discovery.userInfoEndpoint) {
  throw new UnauthorizedException("OIDC UserInfo endpoint is unavailable");
}
const response = await fetch(discovery.userInfoEndpoint, {
  headers: { authorization: `Bearer ${token}` },
});
if (!response.ok) {
  throw new UnauthorizedException("OIDC UserInfo request failed");
}
const claims = (await response.json()) as JWTPayload;
if (claims.sub !== expectedSubject) {
  throw new UnauthorizedException("OIDC UserInfo subject mismatch");
}
return claims;
```

Change `authenticatePrincipalToken` human path to:

```ts
const humanClaims = await this.resolveHumanClaims(token, payload);
return { type: "User", user: await this.findOrProvisionUser(this.getIssuer(), humanClaims) };
```

Do not alter the Service Identity lookup/order.

- [ ] **Step 4: Run OIDC auth tests**

```bash
npm --workspace @resource-portal/api test -- src/auth/oidc-auth.service.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run full auth test subset**

```bash
npm --workspace @resource-portal/api test -- src/auth
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/resourceportal-api/src/auth/oidc-auth.service.ts packages/resourceportal-api/src/auth/oidc-auth.service.spec.ts
git commit -m "feat(auth): resolve human bearer claims via userinfo"
```

---

### Task 3: Provision a dedicated public ZITADEL CLI client during bootstrap

**Files:**
- Modify: `packages/resourceportal-api/scripts/bootstrap-zitadel.ts`
- Test: `test/installer/test-zitadel-management.sh`

**Interfaces:**
- Produces bootstrap JSON field `cliClientId: string` and sidecar `${bootstrapOutputFile}.cli-client-id`.
- Produces an idempotent ZITADEL application named `Resource Portal CLI` in the same project as the web client.
- Consumes current management API enums: `OIDC_APP_TYPE_NATIVE`, `OIDC_AUTH_METHOD_TYPE_NONE`, `OIDC_GRANT_TYPE_DEVICE_CODE`, `OIDC_TOKEN_TYPE_JWT`.

- [ ] **Step 1: Extend installer regression test fixture expectations**

Add assertions that production bootstrap output contains:

```bash
jq -e '.cliClientId | type == "string" and length > 0' "$output_file"
test -s "$output_file.cli-client-id"
test "$(cat "$output_file.cli-client-id")" = "$(jq -r '.cliClientId' "$output_file")"
```

Also assert no CLI secret sidecar/file exists:

```bash
test ! -e "$output_file.cli-client-secret"
```

- [ ] **Step 2: Run ZITADEL installer test and verify failure**

```bash
bash test/installer/test-zitadel-management.sh
```

Expected: FAIL because `cliClientId` is absent.

- [ ] **Step 3: Add idempotent `getOrCreateCliOidcApp`**

In `bootstrap-zitadel.ts`, define a distinct name constant and function:

```ts
const cliAppName = "Resource Portal CLI";

async function getOrCreateCliOidcApp(
  pat: string,
  organizationId: string,
  projectId: string,
) {
  const apps = await zitadelApi<{ result?: App[] }>(
    pat,
    `/management/v1/projects/${projectId}/apps/_search`,
    {},
    organizationId,
  );
  const existing = apps.result?.find((app) => app.name === cliAppName);
  if (existing?.oidcConfig?.clientId) {
    return { appId: existing.id, clientId: existing.oidcConfig.clientId, name: existing.name };
  }
  const created = await zitadelApi<{ appId: string; clientId: string }>(
    pat,
    `/management/v1/projects/${projectId}/apps/oidc`,
    {
      name: cliAppName,
      redirectUris: [],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_DEVICE_CODE"],
      appType: "OIDC_APP_TYPE_NATIVE",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
      postLogoutRedirectUris: [],
      version: "OIDC_VERSION_1_0",
      devMode: false,
      accessTokenType: "OIDC_TOKEN_TYPE_JWT",
      idTokenUserinfoAssertion: true,
    },
    organizationId,
  );
  return { appId: created.appId, clientId: created.clientId, name: cliAppName };
}
```

The Device Code grant value is explicitly covered by the integration test; if the pinned ZITADEL rejects an empty redirect list for Native Device Code, keep the client public/native and use the provider-required native redirect without introducing a secret.

- [ ] **Step 4: Emit CLI client metadata in production bootstrap output**

Call the new function after project creation and include:

```ts
cliClientId: cliApp.clientId,
```

Add sidecar:

```ts
["cli-client-id", cliApp.clientId],
```

Do not add a CLI secret field.

- [ ] **Step 5: Run bootstrap/installer regression**

```bash
npm --workspace @resource-portal/api run build
bash test/installer/test-zitadel-management.sh
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/resourceportal-api/scripts/bootstrap-zitadel.ts test/installer/test-zitadel-management.sh
git commit -m "feat(identity): provision public CLI device client"
```

---

### Task 4: Persist and render CLI client ID across installer lifecycle

**Files:**
- Modify: `scripts/installer/config.sh`
- Modify: `scripts/installer/identity.sh`
- Modify: `scripts/installer/control-plane.sh`
- Modify: `scripts/installer/lifecycle.sh`
- Modify: `scripts/installer/reset.sh`
- Modify: `config/production/stack.yml.tpl`
- Test: `test/installer/test-control-plane.sh`
- Test: `test/installer/test-workflows.sh`
- Test: `test/installer/test-zitadel-management.sh`

**Interfaces:**
- Produces persisted non-secret `RP_CFG_OIDC_CLI_CLIENT_ID`.
- API runtime receives `OIDC_CLI_CLIENT_ID`.
- Upgrade path re-runs idempotent bootstrap/provisioning only when CLI client metadata is absent.

- [ ] **Step 1: Add failing config/render/lifecycle assertions**

Add control-plane assertions:

```bash
grep -q 'OIDC_CLI_CLIENT_ID:' "$rendered_stack"
grep -q "$RP_CFG_OIDC_CLI_CLIENT_ID" "$rendered_stack"
! grep -q 'OIDC_CLI_CLIENT_SECRET' "$rendered_stack"
```

Add workflow assertions that a pre-feature config without `RP_CFG_OIDC_CLI_CLIENT_ID` runs identity reconciliation and ends with a non-empty persisted ID; a second repair/reconfigure preserves the same ID.

- [ ] **Step 2: Run installer tests and verify failure**

```bash
bash test/installer/test-control-plane.sh
bash test/installer/test-workflows.sh
```

Expected: FAIL on missing CLI client config/rendering.

- [ ] **Step 3: Add `RP_CFG_OIDC_CLI_CLIENT_ID` to installer config persistence**

Add the variable to the persisted configuration key list in `config.sh` alongside `RP_CFG_OIDC_CLIENT_ID`.

In `identity.sh`, parse:

```bash
local cli_client_id
cli_client_id="$(jq -r '.cliClientId // empty' "$output_file")"
[[ -n "$cli_client_id" ]] || return 1
RP_CFG_OIDC_CLI_CLIENT_ID="$cli_client_id"
export RP_CFG_OIDC_CLI_CLIENT_ID
```

Read the `.cli-client-id` sidecar in paths that already consume the existing web client sidecars.

- [ ] **Step 4: Make control-plane validation/rendering fail closed**

In `rp_require_stack_config`, require `RP_CFG_OIDC_CLI_CLIENT_ID` when auth mode is ZITADEL.

Add renderer substitution:

```bash
"OIDC_CLI_CLIENT_ID|$RP_CFG_OIDC_CLI_CLIENT_ID"
```

Add API environment in `config/production/stack.yml.tpl`:

```yaml
OIDC_CLI_CLIENT_ID: __OIDC_CLI_CLIENT_ID__
```

Only the API service needs this value.

- [ ] **Step 5: Preserve/provision across lifecycle**

In `lifecycle.sh` follow the existing web client preservation pattern:

```bash
local existing_oidc_cli_client_id="${RP_CFG_OIDC_CLI_CLIENT_ID:-}"
```

Preserve it when valid. When absent during upgrade/repair/reconfigure, run the idempotent ZITADEL bootstrap/reconciliation path and apply the resulting CLI client ID before rendering the stack. Do not reset web client credentials.

- [ ] **Step 6: Reset metadata cleanly**

Add the CLI sidecar to reset cleanup:

```bash
"$RP_INSTALLER_STATE_DIR/zitadel-bootstrap.json.cli-client-id"
```

and ensure generated installer config no longer retains `RP_CFG_OIDC_CLI_CLIENT_ID` after reset.

- [ ] **Step 7: Run installer regression suite**

```bash
bash test/installer/test-zitadel-management.sh
bash test/installer/test-control-plane.sh
bash test/installer/test-workflows.sh
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add scripts/installer/config.sh scripts/installer/identity.sh scripts/installer/control-plane.sh scripts/installer/lifecycle.sh scripts/installer/reset.sh config/production/stack.yml.tpl test/installer/test-control-plane.sh test/installer/test-workflows.sh test/installer/test-zitadel-management.sh
git commit -m "feat(installer): persist CLI OAuth client metadata"
```

---

### Task 5: Centralize CLI auth/config resolution

**Files:**
- Create: `packages/resourceportal-cli/src/auth.ts`
- Create: `packages/resourceportal-cli/test/auth.test.js`
- Modify: `packages/resourceportal-cli/src/index.ts`
- Modify: `packages/resourceportal-cli/src/full-cli.ts`
- Modify: `packages/resourceportal-cli/src/complete-cli.ts`

**Interfaces:**
- Produces:

```ts
export type CliAuthMetadata = {
  mode: "device";
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  expiresAt?: string;
  refreshToken?: string;
};

export type CliConfig = {
  apiUrl?: string;
  devUserId?: string;
  token?: string;
  auth?: CliAuthMetadata;
};

export function readConfig(): CliConfig;
export function writeConfig(config: CliConfig): void;
export function clearConfig(): void;
export async function resolveAuth(apiUrl: string): Promise<{ token?: string; devUserId?: string }>;
```

- Precedence: `RESOURCE_PORTAL_TOKEN` > `RESOURCE_PORTAL_DEV_USER_ID` > stored config.

- [ ] **Step 1: Add failing config/precedence tests**

In `auth.test.js`, run helpers with an isolated HOME/USERPROFILE and assert:

```js
assert.equal(readConfig().token, "legacy-token");
assert.equal((await resolveAuth(apiUrl)).token, "env-token");
```

Also assert that device login metadata is backwards-compatible with old `{apiUrl, token, devUserId}` JSON.

- [ ] **Step 2: Run CLI auth tests and verify failure**

```bash
npm --workspace @resource-portal/cli run build
node --test packages/resourceportal-cli/test/auth.test.js
```

Expected: FAIL because `src/auth.ts` does not exist/export helpers.

- [ ] **Step 3: Implement config read/write/clear in `auth.ts`**

Use existing path and permissions:

```ts
export function configPath() {
  return join(homedir(), ".resourceportal", "config.json");
}

export function writeConfig(config: CliConfig) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
```

`clearConfig()` removes the file if present.

- [ ] **Step 4: Implement credential selection without implicit browser login**

`resolveAuth(apiUrl)` must:

```ts
if (process.env.RESOURCE_PORTAL_TOKEN) return { token: process.env.RESOURCE_PORTAL_TOKEN };
if (process.env.RESOURCE_PORTAL_DEV_USER_ID) return { devUserId: process.env.RESOURCE_PORTAL_DEV_USER_ID };
const config = readConfig();
if (config.devUserId) return { devUserId: config.devUserId };
if (!config.token) return {};
// refresh logic is added in Task 7; for now return stored token.
return { token: config.token };
```

Do not call interactive login here.

- [ ] **Step 5: Replace duplicate config readers**

Import shared `readConfig`/`resolveAuth` in `index.ts`, `full-cli.ts`, and `complete-cli.ts`; remove private duplicate config types/readers once all call sites compile.

- [ ] **Step 6: Run CLI tests**

```bash
npm --workspace @resource-portal/cli test
```

Expected: PASS existing compatibility tests plus new config tests.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/resourceportal-cli/src/auth.ts packages/resourceportal-cli/src/index.ts packages/resourceportal-cli/src/full-cli.ts packages/resourceportal-cli/src/complete-cli.ts packages/resourceportal-cli/test/auth.test.js
git commit -m "refactor(cli): centralize authentication state"
```

---

### Task 6: Implement RFC 8628 device login and browser launch

**Files:**
- Modify: `packages/resourceportal-cli/src/auth.ts`
- Test: `packages/resourceportal-cli/test/auth.test.js`

**Interfaces:**
- Produces:

```ts
export async function interactiveLogin(apiUrl: string): Promise<CliConfig>;
export async function manualTokenLogin(apiUrl: string, token: string): Promise<CliConfig>;
```

- Device flow reads `/auth/cli-config`, OIDC discovery, `device_authorization_endpoint`, and `token_endpoint`; it persists only after RP accepts the token.

- [ ] **Step 1: Add deterministic fake-server tests for the device protocol**

Test these concrete transitions:

```js
// 1. GET /auth/cli-config -> issuer/clientId/scopes
// 2. GET /.well-known/openid-configuration -> device + token endpoints
// 3. POST /oauth/v2/device_authorization -> device_code/user_code/verification_uri_complete
// 4. first token poll -> {error:"authorization_pending"}
// 5. second token poll -> access_token/token_type/expires_in
// 6. GET /api/account (or SDK account endpoint) with Bearer -> 200
// 7. only then config file contains token + auth metadata
```

Add separate tests for `slow_down`, `access_denied`, expiry, malformed token response, browser-open exception, RP token rejection, and manual-token rejection.

- [ ] **Step 2: Run tests and verify failure**

```bash
node --test packages/resourceportal-cli/test/auth.test.js
```

Expected: FAIL because interactive/manual validation functions are absent.

- [ ] **Step 3: Implement HTTP protocol parsers with strict shape checks**

Define local types and assertion functions for:

```ts
type CliAuthConfigResponse = { issuer: string; clientId: string; scopes: string[] };
type DeviceAuthorizationResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};
type DeviceTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
};
```

Reject incomplete/malformed provider data with concise errors and never print token values.

- [ ] **Step 4: Implement best-effort cross-platform browser opening**

Use detached platform commands:

```ts
function openBrowser(url: string) {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}
```

Wrap it so launch failures produce a warning but do not abort polling. Always print `verification_uri` and `user_code`; prefer opening `verification_uri_complete`.

- [ ] **Step 5: Implement RFC 8628 polling**

Use provider `interval` defaulting to 5 seconds and absolute deadline from `expires_in`.

For token endpoint form body:

```ts
new URLSearchParams({
  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  device_code: device.device_code,
  client_id: cliConfig.clientId,
});
```

Handling:

```ts
if (error === "authorization_pending") continue;
if (error === "slow_down") intervalMs += 5000;
if (error === "access_denied") throw new Error("Login denied by user");
if (error === "expired_token") throw new Error("Device login expired. Run rp login again.");
```

No Basic auth/client secret is sent.

- [ ] **Step 6: Validate token against Resource Portal before storage**

Use the SDK client with the candidate bearer token and call the existing account endpoint:

```ts
const client = new ResourcePortalClient({ apiUrl, token: candidate.access_token });
await client.account.get();
```

Only after this succeeds, write:

```ts
{
  apiUrl,
  token: candidate.access_token,
  auth: {
    mode: "device",
    issuer,
    clientId,
    tokenEndpoint,
    revocationEndpoint,
    expiresAt,
    ...(candidate.refresh_token ? { refreshToken: candidate.refresh_token } : {}),
  },
}
```

`manualTokenLogin` performs the same RP account validation and writes `{apiUrl, token}` with stale device/dev metadata removed.

- [ ] **Step 7: Run CLI auth tests**

```bash
npm --workspace @resource-portal/cli run build
node --test packages/resourceportal-cli/test/auth.test.js
```

Expected: PASS all device/manual-login cases.

- [ ] **Step 8: Commit Task 6**

```bash
git add packages/resourceportal-cli/src/auth.ts packages/resourceportal-cli/test/auth.test.js
git commit -m "feat(cli): add browser device authorization login"
```

---

### Task 7: Wire `rp login`, refresh, and logout across all CLI paths

**Files:**
- Modify: `packages/resourceportal-cli/src/auth.ts`
- Modify: `packages/resourceportal-cli/src/index.ts`
- Modify: `packages/resourceportal-cli/src/full-cli.ts`
- Modify: `packages/resourceportal-cli/src/complete-cli.ts`
- Modify: `packages/resourceportal-cli/test/auth.test.js`
- Modify: `packages/resourceportal-cli/test/compatibility.test.js`

**Interfaces:**
- Produces:

```ts
export async function login(options: { apiUrl: string; token?: string; devUserId?: string }): Promise<{apiUrl:string;status:"LoggedIn"}>;
export async function logout(): Promise<{status:"LoggedOut";warning?:string}>;
export async function resolveAuth(apiUrl: string): Promise<{token?:string;devUserId?:string}>;
```

- [ ] **Step 1: Add failing command-level tests**

Assert:

```text
rp login --api-url URL
```

enters device flow, while:

```text
rp login --api-url URL --token TOKEN
```

uses validated manual-token mode and:

```text
rp login --api-url URL --dev-user-id USER_ID
```

stores only dev auth.

Add expiry tests: a stored expired access token without refresh throws exactly `Authentication expired. Run rp login.` and does not open a browser.

- [ ] **Step 2: Run CLI test suite and verify failure**

```bash
npm --workspace @resource-portal/cli test
```

Expected: FAIL on default login/expiry behavior.

- [ ] **Step 3: Make login asynchronous and route modes explicitly**

Implement shared login dispatch:

```ts
export async function login(options: LoginOptions) {
  if (options.devUserId) {
    writeConfig({ apiUrl: options.apiUrl, devUserId: options.devUserId });
  } else if (options.token) {
    await manualTokenLogin(options.apiUrl, options.token);
  } else {
    await interactiveLogin(options.apiUrl);
  }
  return { apiUrl: options.apiUrl, status: "LoggedIn" as const };
}
```

Update CLI runner to `await login(...)`; change help text to:

```text
rp login --api-url URL
rp login --api-url URL --token TOKEN
rp login --api-url URL --dev-user-id USER_ID
```

- [ ] **Step 4: Implement optional refresh-token handling in `resolveAuth`**

If `RESOURCE_PORTAL_TOKEN` is set, return it unchanged.

For stored device auth, if `expiresAt` is more than 60 seconds in the future, return current token. If expired/near-expiry and `refreshToken` exists, POST:

```ts
new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: config.auth.refreshToken,
  client_id: config.auth.clientId,
});
```

On success, validate refreshed bearer against RP, persist new access token/expiry and rotated refresh token if returned. On `invalid_grant`, remove unusable bearer/device auth and throw `Authentication expired. Run rp login.`.

If no refresh token exists, throw the same message without opening a browser.

- [ ] **Step 5: Use `resolveAuth` before constructing clients in all entry paths**

For legacy, compatibility, and health paths, resolve credentials once and pass the result into `ResourcePortalClient`:

```ts
const auth = await resolveAuth(options.apiUrl);
const client = new ResourcePortalClient({
  apiUrl: options.apiUrl,
  token: auth.token,
  devUserId: auth.devUserId,
  ...requestMetadata,
});
```

Keep health endpoints that are intentionally public functional without credentials.

- [ ] **Step 6: Implement logout with best-effort revocation**

Read stored config first. If device auth has a `revocationEndpoint`, revoke refresh token when present, otherwise access token, using public `client_id` according to provider semantics. Catch any network/provider error, record a warning, and always call `clearConfig()` in `finally`.

Never print the token being revoked.

- [ ] **Step 7: Run full CLI tests**

```bash
npm --workspace @resource-portal/cli test
npm --workspace @resource-portal/cli run lint
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

```bash
git add packages/resourceportal-cli/src/auth.ts packages/resourceportal-cli/src/index.ts packages/resourceportal-cli/src/full-cli.ts packages/resourceportal-cli/src/complete-cli.ts packages/resourceportal-cli/test/auth.test.js packages/resourceportal-cli/test/compatibility.test.js
git commit -m "feat(cli): make browser login the default auth flow"
```

---

### Task 8: Documentation, full regressions, and real smoke path

**Files:**
- Modify: `packages/resourceportal-cli/README.md`
- Modify if current docs mention manual-only login: `docs/production-installer.md`
- Modify if appropriate: root `README.md`

**Interfaces:**
- Documents human browser login separately from Service Identity automation.

- [ ] **Step 1: Update CLI README with exact user flows**

Document:

```bash
rp login --api-url https://portal.resource-portal.pl/api
rp account show
rp tenant list -o json
rp logout
```

Automation remains:

```bash
rp login --api-url https://portal.resource-portal.pl/api --token "$RESOURCE_PORTAL_TOKEN"
```

Explain that normal human users no longer create/copy Service Identity secrets for CLI login.

- [ ] **Step 2: Run API tests/build/lint**

```bash
npm --workspace @resource-portal/api test
npm --workspace @resource-portal/api run build
npm --workspace @resource-portal/api run lint
```

Expected: PASS.

- [ ] **Step 3: Run CLI tests/build/lint**

```bash
npm --workspace @resource-portal/cli test
npm --workspace @resource-portal/cli run build
npm --workspace @resource-portal/cli run lint
```

Expected: PASS.

- [ ] **Step 4: Run focused installer/identity suite**

```bash
bash test/installer/test-zitadel-management.sh
bash test/installer/test-control-plane.sh
bash test/installer/test-workflows.sh
```

Expected: PASS.

- [ ] **Step 5: Run repository-wide regressions**

```bash
npm run build
npm run lint
npm test
npm run test:installer
```

Expected: PASS. If an unrelated pre-existing failure exists, capture the exact command/output and do not mask it.

- [ ] **Step 6: Perform real environment smoke test after deploying/upgrading a test Resource Portal**

Run:

```bash
rp logout
rp login --api-url https://portal.resource-portal.pl/api
```

Verify:

```text
- CLI prints verification URL/code.
- Browser opens to ZITADEL.
- User authenticates and approves.
- CLI prints LoggedIn only after RP validates bearer.
```

Then:

```bash
rp account show
rp tenant list -o json
```

Verify both succeed without manual token handling. Also verify a Service Identity `client_credentials` token still works with `--token`/`RESOURCE_PORTAL_TOKEN`.

- [ ] **Step 7: Security inspection**

Run repository scans:

```bash
grep -R "OIDC_CLI_CLIENT_SECRET" -n . --exclude-dir=node_modules --exclude-dir=.git && exit 1 || true
grep -R "rp-cli.*secret\|cli-client-secret" -n config scripts packages --exclude-dir=node_modules && exit 1 || true
```

Inspect generated production stack and installer config to confirm only `OIDC_CLI_CLIENT_ID`/`RP_CFG_OIDC_CLI_CLIENT_ID` are added for CLI auth.

- [ ] **Step 8: Commit documentation/final integration changes**

```bash
git add packages/resourceportal-cli/README.md docs/production-installer.md README.md 2>/dev/null || true
git commit -m "docs(cli): document browser login flow"
```

Only include files actually modified.

---

## Plan Self-Review

### Spec coverage

- Default browser/device login: Tasks 6-7.
- Public CLI config endpoint: Task 1.
- Human JWT/UserInfo compatibility: Task 2.
- Dedicated no-secret ZITADEL client: Task 3.
- Installer fresh/upgrade/repair/reconfigure/reset lifecycle: Task 4.
- Shared CLI auth module and precedence: Task 5.
- Manual token validation: Task 6.
- Optional refresh/no-refresh expiry behavior: Task 7.
- Best-effort revocation/logout: Task 7.
- No implicit browser from normal commands: Tasks 5 and 7.
- Service Identity compatibility: Tasks 2, 7, 8.
- Full security/regression/smoke verification: Task 8.

### Type consistency

The same `CliConfig`, `CliAuthMetadata`, `interactiveLogin`, `manualTokenLogin`, `resolveAuth`, `login`, and `logout` interfaces are used consistently across Tasks 5-7. API discovery fields introduced in Task 1 are consumed by Task 2 and exposed indirectly to Task 6 through standard OIDC discovery.

### No-placeholder check

The plan contains no `TBD`, `TODO`, or deferred implementation placeholders. Provider-specific Device Code behavior is fixed to RFC 8628 and `OIDC_GRANT_TYPE_DEVICE_CODE`; integration tests are required to reject incompatible provisioning rather than silently degrading to another auth mode.
