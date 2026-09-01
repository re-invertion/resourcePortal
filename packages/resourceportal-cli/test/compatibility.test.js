const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const { resolve } = require("node:path");
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

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        RESOURCE_PORTAL_API_URL: "",
        RESOURCE_PORTAL_TOKEN: "",
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
});
