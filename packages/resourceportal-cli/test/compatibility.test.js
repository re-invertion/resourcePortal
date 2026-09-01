const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const packageJson = require("../package.json");

function cliHelp() {
  const bin = resolve(__dirname, "..", packageJson.bin.rp);
  return spawnSync(process.execPath, [bin, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RESOURCE_PORTAL_API_URL: "https://rp.example/api",
    },
  });
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
    "--correlation-id ID",
    "--request-id ID",
  ]) {
    assert.match(result.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
