const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalToken = process.env.RESOURCE_PORTAL_TOKEN;
const originalDevUserId = process.env.RESOURCE_PORTAL_DEV_USER_ID;

function loadAuth() {
  delete require.cache[require.resolve("../dist/auth.js")];
  return require("../dist/auth.js");
}

function withHome() {
  const home = mkdtempSync(join(tmpdir(), "rp-cli-auth-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function restoreEnv() {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  if (originalToken === undefined) delete process.env.RESOURCE_PORTAL_TOKEN; else process.env.RESOURCE_PORTAL_TOKEN = originalToken;
  if (originalDevUserId === undefined) delete process.env.RESOURCE_PORTAL_DEV_USER_ID; else process.env.RESOURCE_PORTAL_DEV_USER_ID = originalDevUserId;
}

test.afterEach(restoreEnv);

test("reads legacy config and writes device auth metadata compatibly", () => {
  const home = withHome();
  const dir = join(home, ".resourceportal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    apiUrl: "https://rp.example/api",
    token: "legacy-token",
    devUserId: "legacy-user",
  }));
  const { readConfig, writeConfig } = loadAuth();

  assert.equal(readConfig().token, "legacy-token");
  writeConfig({
    apiUrl: "https://rp.example/api",
    token: "device-access-token",
    auth: {
      mode: "device",
      issuer: "https://auth.example",
      clientId: "cli-client",
      tokenEndpoint: "https://auth.example/oauth/v2/token",
      expiresAt: "2026-09-13T00:00:00.000Z",
      refreshToken: "refresh-token",
    },
  });

  const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(stored.auth.mode, "device");
  assert.equal(readConfig().auth.clientId, "cli-client");
  rmSync(home, { recursive: true, force: true });
});

test("environment token overrides development and stored credentials", async () => {
  const home = withHome();
  const { writeConfig, resolveAuth } = loadAuth();
  writeConfig({ token: "stored-token", devUserId: "stored-dev" });
  process.env.RESOURCE_PORTAL_DEV_USER_ID = "env-dev";
  process.env.RESOURCE_PORTAL_TOKEN = "env-token";

  assert.deepEqual(await resolveAuth("https://rp.example/api"), { token: "env-token" });
  rmSync(home, { recursive: true, force: true });
});

test("environment dev user overrides stored credentials when token is absent", async () => {
  const home = withHome();
  const { writeConfig, resolveAuth } = loadAuth();
  writeConfig({ token: "stored-token", devUserId: "stored-dev" });
  delete process.env.RESOURCE_PORTAL_TOKEN;
  process.env.RESOURCE_PORTAL_DEV_USER_ID = "env-dev";

  assert.deepEqual(await resolveAuth("https://rp.example/api"), { devUserId: "env-dev" });
  rmSync(home, { recursive: true, force: true });
});

test("stored dev user takes precedence over stored token and clearConfig removes state", async () => {
  const home = withHome();
  const { writeConfig, resolveAuth, clearConfig, readConfig } = loadAuth();
  delete process.env.RESOURCE_PORTAL_TOKEN;
  delete process.env.RESOURCE_PORTAL_DEV_USER_ID;
  writeConfig({ token: "stored-token", devUserId: "stored-dev" });

  assert.deepEqual(await resolveAuth("https://rp.example/api"), { devUserId: "stored-dev" });
  clearConfig();
  assert.deepEqual(readConfig(), {});
  rmSync(home, { recursive: true, force: true });
});

const http = require("node:http");

async function startDeviceAuthServer(options = {}) {
  const requests = [];
  const tokenResponses = [...(options.tokenResponses || [
    { status: 400, body: { error: "authorization_pending" } },
    { status: 200, body: { access_token: "device-token", token_type: "Bearer", expires_in: 3600 } },
  ])];
  let baseUrl = "";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: bodyText });
      const json = (status, value) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      if (req.method === "GET" && req.url === "/api/auth/cli-config") {
        return json(200, {
          issuer: baseUrl,
          clientId: "rp-cli-client",
          scopes: ["openid", "profile", "email", "rp-audience"],
        });
      }
      if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
        return json(200, {
          issuer: baseUrl,
          device_authorization_endpoint: `${baseUrl}/oauth/v2/device_authorization`,
          token_endpoint: `${baseUrl}/oauth/v2/token`,
          revocation_endpoint: `${baseUrl}/oauth/v2/revoke`,
        });
      }
      if (req.method === "POST" && req.url === "/oauth/v2/device_authorization") {
        return json(200, {
          device_code: "device-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: `${baseUrl}/device`,
          verification_uri_complete: `${baseUrl}/device?user_code=ABCD-EFGH`,
          expires_in: 120,
          interval: options.interval ?? 0,
        });
      }
      if (req.method === "POST" && req.url === "/oauth/v2/token") {
        const next = tokenResponses.shift() || { status: 400, body: { error: "expired_token" } };
        return json(next.status, next.body);
      }
      if (req.method === "GET" && req.url === "/api/auth/me") {
        if (options.accountStatus && options.accountStatus !== 200) {
          return json(options.accountStatus, { message: "rejected" });
        }
        return json(200, { id: "user-1", email: "patryk@example.test" });
      }
      return json(404, { message: "not found" });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    apiUrl: `${baseUrl}/api`,
    requests,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function testRuntime(overrides = {}) {
  return {
    sleep: async () => {},
    openBrowser: async () => {},
    now: () => Date.parse("2026-09-12T18:00:00.000Z"),
    log: () => {},
    warn: () => {},
    ...overrides,
  };
}

test("interactive login completes device flow, validates RP token, then stores it", async () => {
  const home = withHome();
  delete process.env.RESOURCE_PORTAL_TOKEN;
  delete process.env.RESOURCE_PORTAL_DEV_USER_ID;
  const server = await startDeviceAuthServer();
  try {
    const { interactiveLogin, readConfig } = loadAuth();
    const opened = [];
    const config = await interactiveLogin(server.apiUrl, testRuntime({
      openBrowser: async (url) => opened.push(url),
    }));

    assert.equal(config.token, "device-token");
    assert.equal(config.auth.mode, "device");
    assert.equal(config.auth.clientId, "rp-cli-client");
    assert.equal(config.auth.refreshToken, undefined);
    assert.equal(readConfig().token, "device-token");
    assert.deepEqual(opened, [`${server.apiUrl.slice(0, -4)}/device?user_code=ABCD-EFGH`]);

    const deviceRequest = server.requests.find((r) => r.url === "/oauth/v2/device_authorization");
    const deviceBody = new URLSearchParams(deviceRequest.body);
    assert.equal(deviceBody.get("client_id"), "rp-cli-client");
    assert.equal(deviceBody.get("scope"), "openid profile email rp-audience");

    const polls = server.requests.filter((r) => r.url === "/oauth/v2/token");
    assert.equal(polls.length, 2);
    const pollBody = new URLSearchParams(polls[0].body);
    assert.equal(pollBody.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
    assert.equal(pollBody.get("device_code"), "device-code-1");
    assert.equal(pollBody.get("client_id"), "rp-cli-client");
    assert.equal(polls[0].headers.authorization, undefined);

    const validation = server.requests.find((r) => r.url === "/api/auth/me");
    assert.equal(validation.headers.authorization, "Bearer device-token");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("device polling handles slow_down by increasing the next interval", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    interval: 1,
    tokenResponses: [
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "device-token", token_type: "Bearer" } },
    ],
  });
  try {
    const { interactiveLogin } = loadAuth();
    const sleeps = [];
    await interactiveLogin(server.apiUrl, testRuntime({ sleep: async (ms) => sleeps.push(ms) }));
    assert.deepEqual(sleeps.slice(0, 2), [1000, 6000]);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("device login denial stores no credentials", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    tokenResponses: [{ status: 400, body: { error: "access_denied" } }],
  });
  try {
    const { interactiveLogin, readConfig } = loadAuth();
    await assert.rejects(
      interactiveLogin(server.apiUrl, testRuntime()),
      /Login denied by user/,
    );
    assert.deepEqual(readConfig(), {});
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("expired device code stores no credentials", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    tokenResponses: [{ status: 400, body: { error: "expired_token" } }],
  });
  try {
    const { interactiveLogin, readConfig } = loadAuth();
    await assert.rejects(
      interactiveLogin(server.apiUrl, testRuntime()),
      /Device login expired\. Run rp login again\./,
    );
    assert.deepEqual(readConfig(), {});
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("malformed successful token response is rejected without persistence", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    tokenResponses: [{ status: 200, body: { token_type: "Bearer" } }],
  });
  try {
    const { interactiveLogin, readConfig } = loadAuth();
    await assert.rejects(
      interactiveLogin(server.apiUrl, testRuntime()),
      /OIDC token endpoint returned malformed data/,
    );
    assert.deepEqual(readConfig(), {});
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("browser launch failure warns but device login continues", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    tokenResponses: [{ status: 200, body: { access_token: "device-token", token_type: "Bearer" } }],
  });
  try {
    const { interactiveLogin } = loadAuth();
    const warnings = [];
    const config = await interactiveLogin(server.apiUrl, testRuntime({
      openBrowser: async () => { throw new Error("no browser"); },
      warn: (message) => warnings.push(message),
    }));
    assert.equal(config.token, "device-token");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not open browser/);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("RP rejection after device token issuance stores nothing", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({
    accountStatus: 401,
    tokenResponses: [{ status: 200, body: { access_token: "bad-device-token", token_type: "Bearer" } }],
  });
  try {
    const { interactiveLogin, readConfig } = loadAuth();
    await assert.rejects(interactiveLogin(server.apiUrl, testRuntime()));
    assert.deepEqual(readConfig(), {});
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("manual token login validates token and rejects invalid token without persistence", async () => {
  const home = withHome();
  const server = await startDeviceAuthServer({ accountStatus: 401 });
  try {
    const { manualTokenLogin, readConfig } = loadAuth();
    await assert.rejects(manualTokenLogin(server.apiUrl, "manual-bad-token"));
    assert.deepEqual(readConfig(), {});
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
