const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { resolve } = require("node:path");
const packageJson = require("../package.json");

const bin = resolve(__dirname, "..", packageJson.bin.rp);

function runCli(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        RESOURCE_PORTAL_API_URL: "",
        RESOURCE_PORTAL_TOKEN: "",
        RESOURCE_PORTAL_DEV_USER_ID: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function withOperationServer(states, fn) {
  const calls = [];
  let poll = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      calls.push(`${request.method} ${request.url}`);
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "POST" && request.url === "/api/tenants/tenant-a/volumes") {
        return send(200, { id: "op-1", status: "Pending" });
      }
      if (request.method === "GET" && request.url === "/api/tenants/tenant-a/operations/op-1") {
        return send(200, states[Math.min(poll++, states.length - 1)]);
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
  assert.ok(address);

  try {
    await fn(`http://127.0.0.1:${address.port}/api`, calls);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function createArgs(apiUrl, wait) {
  return [
    "volume",
    "create",
    "tenant-a",
    "--name",
    "data",
    "--size-bytes",
    "1024",
    ...(wait ? ["--wait"] : []),
    "--dev-user-id",
    "test-user",
    "--api-url",
    apiUrl,
    "--output",
    "json",
  ];
}

test("volume create remains asynchronous without --wait", async () => {
  await withOperationServer(
    [{ id: "op-1", status: "Succeeded" }],
    async (apiUrl, calls) => {
      const result = await runCli(createArgs(apiUrl, false));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "Pending");
      assert.deepEqual(calls, ["POST /api/tenants/tenant-a/volumes"]);
    },
  );
});

test("volume create --wait polls until Succeeded", async () => {
  await withOperationServer(
    [
      { id: "op-1", status: "Running" },
      { id: "op-1", status: "Succeeded", resourceId: "vol-1" },
    ],
    async (apiUrl, calls) => {
      const result = await runCli(createArgs(apiUrl, true));
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, "Succeeded");
      assert.equal(output.resourceId, "vol-1");
      assert.equal(
        calls.filter((call) => call === "GET /api/tenants/tenant-a/operations/op-1").length,
        2,
      );
    },
  );
});

test("volume create --wait exits non-zero with operation failure details", async () => {
  await withOperationServer(
    [
      {
        id: "op-1",
        status: "Failed",
        errorCode: "QuotaApplyFailed",
        errorMessage: "xfs quota rejected",
      },
    ],
    async (apiUrl) => {
      const result = await runCli(createArgs(apiUrl, true));
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /QuotaApplyFailed/);
      assert.match(result.stderr, /xfs quota rejected/);
    },
  );
});
