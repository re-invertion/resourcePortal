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

test("unknown runtime changes fail closed, not silently skip test coverage", () => {
  assert.throws(
    () => selectProfiles(["packages/resourceportal-api/src/security/new-auth.ts"]),
    /unclassified changes/,
  );
});

test("MCP OAuth patch chooses the existing targeted regression suite", () => {
  const plan = selectProfiles([".github/workflows/fastfix.yml"]);
  assert.deepEqual(plan.profiles, ["workflow"]);
  assert.equal(plan.vpnSmoke, false);
});
