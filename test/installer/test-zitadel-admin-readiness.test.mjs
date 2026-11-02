import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const installer = readFileSync("scripts/installer/identity.sh", "utf8");
const functionSource = installer.split("rp_run_zitadel_mcp_oauth_reconcile() {")[1]?.split("\nrp_run_zitadel_web_oidc_reconcile()")[0];
assert.ok(functionSource, "MCP OAuth reconcile must remain present");
const readinessScript = functionSource.match(/^  readiness_script='(.*)'$/m)?.[1];
assert.ok(readinessScript, "Authenticated readiness script is required");

async function runSequence(statuses, timeoutSeconds = 2) {
  const dir = mkdtempSync(join(tmpdir(), "rp-zitadel-readiness-"));
  const patFile = join(dir, "admin.pat");
  const pat = "test-PAT-NEVER-LOG-0123456789";
  writeFileSync(patFile, `${pat}\n`, { mode: 0o600 });
  let requests = 0;
  const headers = [];
  const paths = [];
  const server = createServer((req, res) => {
    requests += 1;
    headers.push(req.headers);
    paths.push(req.url);
    res.writeHead(statuses[Math.min(requests - 1, statuses.length - 1)], { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", readinessScript], {
        env: {
          ...process.env,
          ZITADEL_ISSUER_URL: `http://127.0.0.1:${port}`,
          ZITADEL_BOOTSTRAP_INSTANCE_HOST: "idp.example.test",
          ZITADEL_BOOTSTRAP_PAT_FILE: patFile,
          ZITADEL_BOOTSTRAP_READY_TIMEOUT_SECONDS: String(timeoutSeconds),
        },
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(pat), "PAT must never be logged");
    return { ...result, requests, headers, paths, pat };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ZITADEL MCP readiness waits for authenticated Admin API rather than /debug/ready", async () => {
  const result = await runSequence([503, 503, 200]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.requests, 3);
  assert.match(result.stdout, /Admin API ready/);
  for (const [index, headers] of result.headers.entries()) {
    assert.equal(result.paths[index], "/admin/v1/policies/label");
    assert.equal(headers.authorization, `Bearer ${result.pat}`);
    assert.equal(headers["x-zitadel-instance-host"], "idp.example.test");
    assert.equal(headers["x-zitadel-public-host"], "idp.example.test");
  }
});

test("ZITADEL MCP readiness rejects permanent authorization failures without retry", async () => {
  const result = await runSequence([401, 200]);
  assert.equal(result.code, 1);
  assert.equal(result.requests, 1);
  assert.match(result.stderr, /permanent failure: HTTP 401/);
});

test("ZITADEL MCP readiness timeout fails closed with bounded diagnostics", async () => {
  const result = await runSequence([503], 1);
  assert.equal(result.code, 1);
  assert.ok(result.requests >= 1);
  assert.match(result.stderr, /deadline exceeded/);
  assert.match(result.stderr, /last=HTTP 503/);
});
