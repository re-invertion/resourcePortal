const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const packageJson = require("../package.json");

const bin = resolve(__dirname, "..", packageJson.bin.rp);

function cliHelp() {
  return spawnSync(process.execPath, [bin, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RESOURCE_PORTAL_API_URL: "https://rp.example/api",
    },
  });
}

function runCli(args, envOverrides = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        RESOURCE_PORTAL_API_URL: "",
        RESOURCE_PORTAL_TOKEN: "",
        RESOURCE_PORTAL_DEV_USER_ID: "",
        ...envOverrides,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stderr, stdout }));
  });
}

async function captureJsonRequest(args) {
  let captured;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      captured = {
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
        method: request.method,
        url: request.url,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const result = await runCli([
      ...args,
      "--api-url",
      `http://127.0.0.1:${address.port}/api`,
      "--output",
      "json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(captured, "CLI did not send an HTTP request");
    return captured;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test("global help exposes post-Stage-8 compatibility commands", () => {
  const result = cliHelp();
  assert.equal(result.status, 0, result.stderr);

  for (const expected of [
    "platform-billing voucher-list",
    "swarm reconcile",
    "remote-location maintenance",
    "storage-backend validate",
    "operation retry",
    "platform-maintenance set",
    "oauth-application rotate-credentials",
    "platform-oauth-application rotate-credentials",
    "service-identity rotate-credentials",
    "platform-service-identity rotate-credentials",
    "platform-identity-provider list",
    "audit export",
    "metrics show",
    "health ready",
    "--correlation-id ID",
    "--request-id ID",
  ]) {
    assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("billing decimal mutation flags are sent as strings", async () => {
  const request = await captureJsonRequest([
    "platform-billing",
    "payment",
    "--tenant-id",
    "00000000-0000-4000-8000-000000000001",
    "--amount-credits",
    "25.5",
  ]);

  assert.equal(request.method, "POST");
  assert.equal(request.body.amountCredits, "25.5");
  assert.equal(typeof request.body.amountCredits, "string");
});

test("singleton DTO array flags are sent as arrays", async () => {
  const serviceIdentityRequest = await captureJsonRequest([
    "service-identity",
    "create",
    "00000000-0000-4000-8000-000000000001",
    "--name",
    "automation",
    "--role-ids",
    "role-one",
  ]);
  assert.deepEqual(serviceIdentityRequest.body.roleIds, ["role-one"]);

  const oauthRequest = await captureJsonRequest([
    "oauth-application",
    "create",
    "00000000-0000-4000-8000-000000000001",
    "--name",
    "web-client",
    "--type",
    "Web",
    "--redirect-uris",
    "https://example.test/callback",
    "--post-logout-redirect-uris",
    "https://example.test/logout",
  ]);
  assert.deepEqual(oauthRequest.body.redirectUris, ["https://example.test/callback"]);
  assert.deepEqual(oauthRequest.body.postLogoutRedirectUris, ["https://example.test/logout"]);

  const identityProviderRequest = await captureJsonRequest([
    "platform-identity-provider",
    "create",
    "--name",
    "company-oidc",
    "--protocol",
    "OIDC",
    "--scopes",
    "openid",
  ]);
  assert.deepEqual(identityProviderRequest.body.scopes, ["openid"]);
});


async function startLoginCommandServer() {
  let baseUrl = "";
  const calls = { cliConfig: 0, device: 0, token: 0, account: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && request.url === "/api/auth/cli-config") {
        calls.cliConfig += 1;
        return send(200, { issuer: baseUrl, clientId: "cli-command-client", scopes: ["openid", "rp-aud"] });
      }
      if (request.method === "GET" && request.url === "/.well-known/openid-configuration") {
        return send(200, {
          issuer: baseUrl,
          device_authorization_endpoint: `${baseUrl}/oauth/v2/device_authorization`,
          token_endpoint: `${baseUrl}/oauth/v2/token`,
        });
      }
      if (request.method === "POST" && request.url === "/oauth/v2/device_authorization") {
        calls.device += 1;
        return send(200, {
          device_code: "command-device-code",
          user_code: "COMMAND-CODE",
          verification_uri: `${baseUrl}/device`,
          verification_uri_complete: `${baseUrl}/device?user_code=COMMAND-CODE`,
          expires_in: 60,
          interval: 0,
        });
      }
      if (request.method === "POST" && request.url === "/oauth/v2/token") {
        calls.token += 1;
        return send(200, { access_token: "command-device-token", token_type: "Bearer", expires_in: 3600 });
      }
      if (request.method === "GET" && request.url === "/api/auth/me") {
        calls.account.push(request.headers.authorization);
        return send(200, { id: "user-command" });
      }
      return send(404, { message: "not found" });
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
    calls,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function readCliConfig(home) {
  return JSON.parse(readFileSync(join(home, ".resourceportal", "config.json"), "utf8"));
}

test("rp login without credentials runs browser device authorization", async () => {
  const server = await startLoginCommandServer();
  const home = mkdtempSync(join(tmpdir(), "rp-cli-command-"));
  try {
    const result = await runCli(
      ["login", "--api-url", server.apiUrl, "--output", "json"],
      { HOME: home, USERPROFILE: home, PATH: "" },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.calls.cliConfig, 1);
    assert.equal(server.calls.device, 1);
    assert.equal(server.calls.token, 1);
    assert.deepEqual(server.calls.account, ["Bearer command-device-token"]);
    const stored = readCliConfig(home);
    assert.equal(stored.token, "command-device-token");
    assert.equal(stored.auth.mode, "device");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("rp login --token validates manual bearer before reporting LoggedIn", async () => {
  const server = await startLoginCommandServer();
  const home = mkdtempSync(join(tmpdir(), "rp-cli-command-"));
  try {
    const result = await runCli(
      ["login", "--api-url", server.apiUrl, "--token", "manual-command-token", "--output", "json"],
      { HOME: home, USERPROFILE: home },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(server.calls.account, ["Bearer manual-command-token"]);
    assert.deepEqual(readCliConfig(home), { apiUrl: server.apiUrl, token: "manual-command-token" });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("rp login --dev-user-id stores only development authentication", async () => {
  const home = mkdtempSync(join(tmpdir(), "rp-cli-command-"));
  try {
    const result = await runCli(
      ["login", "--api-url", "http://127.0.0.1:9/api", "--dev-user-id", "dev-command-user", "--output", "json"],
      { HOME: home, USERPROFILE: home },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readCliConfig(home), {
      apiUrl: "http://127.0.0.1:9/api",
      devUserId: "dev-command-user",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
