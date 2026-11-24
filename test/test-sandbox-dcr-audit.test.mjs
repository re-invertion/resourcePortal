import test from "node:test";
import assert from "node:assert/strict";

const issuer = "https://auth-sandbox.resource-portal.pl";
const projectPath = "/management/v1/projects/_search";
const appsPath = "/management/v1/projects/dcr-project/apps/_search";
const prefix = "RP sandbox scoped DCR verify ";
let importSequence = 0;

async function auditWithStubbedInventory(scenario) {
  // The script is deliberately executed as-written against an in-memory
  // fetch shim; it cannot contact the existing sandbox or register a client.
  const previous = {
    fetch: globalThis.fetch, log: console.log, error: console.error,
    auditToken: process.env.ZITADEL_SANDBOX_AUDIT_TOKEN,
    exitCode: process.exitCode,
  };
  const logs = [];
  const errors = [];
  const seen = [];
  try {
    process.env.ZITADEL_SANDBOX_AUDIT_TOKEN = "test-private-audit-token";
    process.exitCode = 0;
    console.log = (...args) => { logs.push(args.join(" ")); };
    console.error = (...args) => { errors.push(args.map(String).join(" ")); };
    globalThis.fetch = async (url, options) => {
      assert.equal(new URL(String(url)).origin, issuer,
        "Sandbox orphan audit must not issue network requests to another host");
      const path = new URL(String(url)).pathname;
      seen.push({ method: options?.method ?? "GET", path });
      if (path === "/.well-known/openid-configuration") {
        assert.equal(options?.method, "GET");
        return Response.json({ issuer, registration_endpoint: issuer + "/oauth/v2/register" });
      }
      assert.equal(options?.method, "POST", "Audit must never mutate resources");
      assert.equal(options?.headers.authorization, "Bearer test-private-audit-token");
      const body = JSON.parse(options.body);
      if (path === projectPath) {
        return Response.json({
          details: { totalResult: "1" }, result: [{ id: "dcr-project", name: "ZITADEL DCR" }],
        });
      }
      assert.equal(path, appsPath);
      const offset = body.query.offset ?? 0;
      if (scenario === "denied") {
        return Response.json({ error: "permission_denied" }, { status: 403 });
      }
      const firstPage = Array.from({ length: 100 }, (_, i) => ({
        id: "app-" + i, name: i === 0 ? prefix + "candidate" : "unrelated-" + i,
        oidcConfig: { clientId: "client-" + i },
      }));
      const laterPage = [{
        id: scenario === "repeated" ? "app-0" : "app-100",
        name: "unrelated-100", oidcConfig: { clientId: "client-100" },
      }];
      return Response.json({
        details: { totalResult: "101" },
        result: offset === 0 ? firstPage : laterPage,
      });
    };
    await import(new URL("../scripts/audit-sandbox-dcr-orphans.mjs?case=" + ++importSequence,
      import.meta.url));
    return { logs: logs.join("\n"), errors: errors.join("\n"),
      exitCode: process.exitCode, seen };
  } finally {
    globalThis.fetch = previous.fetch;
    console.log = previous.log;
    console.error = previous.error;
    if (previous.auditToken === undefined) delete process.env.ZITADEL_SANDBOX_AUDIT_TOKEN;
    else process.env.ZITADEL_SANDBOX_AUDIT_TOKEN = previous.auditToken;
    process.exitCode = previous.exitCode;
  }
}

test("sandbox audit refuses a duplicated app across complete-count pages", async () => {
  const result = await auditWithStubbedInventory("repeated");
  assert.equal(result.exitCode, 1);
  assert.match(result.errors, /Repeated management identity across pages; audit is UNKNOWN/);
  assert.equal(result.logs, "", "A partial inventory must not be presented as a complete snapshot");
  assert.deepEqual(result.seen.map(x => x.method), ["GET", "POST", "POST", "POST"]);
  assert.doesNotMatch(result.errors, /test-private-audit-token/);
});

test("sandbox audit reports exact candidate IDs on complete unique pages without mutation", async () => {
  const result = await auditWithStubbedInventory("unique");
  assert.equal(result.exitCode, 3, "A candidate orphan requires operator attention");
  const report = JSON.parse(result.logs);
  assert.equal(report.environment, "existing-sandbox-only");
  assert.equal(report.auditedApplications, 101);
  assert.deepEqual(report.matchingCandidates, [{
    applicationId: "app-0", clientId: "client-0", name: prefix + "candidate",
  }]);
  assert.equal(result.errors, "");
  assert.deepEqual(result.seen.map(x => x.method), ["GET", "POST", "POST", "POST"]);
  assert.doesNotMatch(result.logs, /test-private-audit-token/);
});

test("sandbox audit fails closed on management permission denial", async () => {
  const result = await auditWithStubbedInventory("denied");
  assert.equal(result.exitCode, 1);
  assert.match(result.errors, /Sandbox management search failed with HTTP 403/);
  assert.equal(result.logs, "");
  assert.deepEqual(result.seen.map(x => x.method), ["GET", "POST", "POST"]);
  assert.doesNotMatch(result.errors, /test-private-audit-token/);
});
