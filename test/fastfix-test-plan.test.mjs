import { test } from "node:test";
import { strict as assert } from "node:assert";
import { selectProfiles } from "../scripts/fastfix-test-plan.mjs";

test("patch VPN release selects related API, UI, installer and real dataplane smoke", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/networking/device-vpn-runtime.logic.ts",
    "packages/resourceportal-web/src/pages/device-vpn-panel.tsx",
    "scripts/installer/firewall.sh",
  ]);
  assert.equal(plan.vpnSmoke, true);
  assert.deepEqual(plan.profiles, ["installer", "networking", "web-console"]);
});

test("documentation-only change does not trigger unrelated tests", () => {
  const plan = selectProfiles(["docs/advanced-networking-resourceportalgate.md"]);
  assert.deepEqual(plan.profiles, []);
  assert.equal(plan.vpnSmoke, false);
});

test("security runtime changes select security tests (never silently skipped)", () => {
  assert.deepEqual(selectProfiles(["packages/resourceportal-api/src/security/new-auth.ts"]).profiles, ["security"]);
});
test("unregistered root-level changes still fail closed", () => {
  assert.throws(() => selectProfiles(["new-unmapped-runtime/entry.ts"]), /unclassified changes/);
});
test("unregistered API modules safely fall back to full API tests", () => {
  assert.deepEqual(selectProfiles(["packages/resourceportal-api/src/new-domain/new.service.ts"]).profiles, ["api-general"]);
});

test("MCP OAuth patch chooses the existing targeted regression suite", () => {
  const plan = selectProfiles([".github/workflows/fastfix.yml"]);
  assert.deepEqual(plan.profiles, ["workflow"]);
  assert.equal(plan.vpnSmoke, false);
});


test("v0.2.67 bugfix files select only their affected patch profiles", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/domains/domains.service.ts",
    "packages/resourceportal-api/src/platform-dns/cloudflare-tenant-oauth.service.ts",
    "packages/resourceportal-api/src/mcp/admin-mcp-protocol.service.ts",
    "packages/resourceportal-api/src/bug-reports/platform-bug-reports.controller.ts",
    "packages/resourceportal-api/src/app-groups/app-groups.service.ts",
    "packages/resourceportal-api/src/platform-infrastructure/platform-release.service.ts",
    "packages/resourceportal-api/src/operations/executors/platform-release-update-operation.executor.ts",
    "packages/resourceportal-api/src/storage-backends/storage-command-runner.service.ts",
    "packages/resourceportal-api/src/worker-execution.module.ts",
    "packages/resourceportal-web/src/pages/tenant-storage-pages.tsx",
    "packages/resourceportal-web/src/pages/app-group/app-detail.tsx",
    "packages/resourceportal-web/src/pages/platform-final-pages.tsx",
    "packages/resourceportal-web/src/pages/platform-mcp.tsx",
    "packages/resourceportal-web/src/pages/tenant-networking-graph.tsx",
    "scripts/installer/upgrade.sh",
    "config/production/stack.yml.tpl",
    "Dockerfile",
  ]);
  assert.deepEqual(plan.profiles, [
    "applications",
    "bug-reports",
    "domains",
    "networking",
    "platform-admin-ui",
    "platform-release",
    "web-console",
    "worker",
  ]);
  assert.equal(plan.vpnSmoke, true);
});

test("workflow contract changes stay inside the workflow patch profile", () => {
  const plan = selectProfiles([
    ".github/workflows/release.yml",
    "scripts/fastfix-test-plan.mjs",
    "test/fastfix-test-plan.test.mjs",
    "test/installer/test-workflows.sh",
  ]);
  assert.deepEqual(plan.profiles, ["workflow"]);
  assert.equal(plan.vpnSmoke, false);
});
