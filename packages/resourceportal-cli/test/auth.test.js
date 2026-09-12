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
