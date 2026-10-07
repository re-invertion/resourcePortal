#!/usr/bin/env node
/**
 * Strict, change-scoped validation for patch releases.
 *
 * New executable areas MUST be registered here. Unknown paths fail closed:
 * silently skipping a test for a changed area is not a successful fastfix.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const commands = {
  "networking": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/networking"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/device-vpn-panel.test.tsx", "src/pages/tenant-networking.test.tsx", "src/pages/tenant-networking-bgp.test.tsx"],
    ["bash", "test/installer/test-host-runtime.sh"],
  ],
  "web-console": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/device-vpn-panel.test.tsx", "src/pages/tenant-networking.test.tsx", "src/pages/help.test.tsx"],
  ],
  "worker": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/observability/worker-runtime-observability.service.spec.ts", "src/worker-startup-resync.spec.ts", "src/worker-one-shot-schedulers.spec.ts", "src/networking/device-vpn-runtime-reconciler.service.spec.ts"],
  ],
  "schema": [
    ["npm", "--workspace", "@resource-portal/api", "exec", "--", "prisma", "validate", "--schema", "prisma/schema.prisma"],
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/networking/device-vpn-migration.spec.ts"],
  ],
  "sdk": [["npm", "--workspace", "@resource-portal/sdk", "test"]],
  "cli": [["npm", "run", "test:cli-release"]],
  "help": [["npm", "--workspace", "@resource-portal/help", "test"]],
  "installer": [
    ["bash", "test/installer/test-host-runtime.sh"],
    ["bash", "test/installer/test-diagnostics.sh"],
  ],
  "dependency": [["npm", "audit", "--audit-level=high"]],
  "workflow": [
    ["node", "--test", "test/fastfix-test-plan.test.mjs", "test/release-validation-mode.test.mjs"],
    ["bash", "-n", "scripts/run-device-vpn-dataplane-smoke.sh"],
  ],
  "mcp-oauth": [["npm", "run", "test:fastfix:mcp-oauth"]],
};

const classifiers = [
  [/^packages\/resourceportal-api\/src\/networking\//, ["networking"]],
  [/^packages\/resourceportal-api\/src\/mcp\//, ["mcp-oauth"]],
  [/^packages\/resourceportal-api\/src\/auth\//, ["mcp-oauth"]],
  [/^packages\/resourceportal-api\/src\/observability\/worker-runtime-observability/, ["worker"]],
  [/^packages\/resourceportal-api\/src\/(worker-execution.module|worker.runner)\.ts$/, ["worker"]],
  [/^packages\/resourceportal-api\/(prisma\/|src\/prisma\/seed\.ts)/, ["schema", "networking"]],
  [/^packages\/resourceportal-sdk\//, ["sdk"]],
  [/^packages\/resourceportal-cli\//, ["cli"]],
  [/^packages\/resourceportal-help\//, ["help"]],
  [/^packages\/resourceportal-web\/src\/pages\/(device-vpn|tenant-networking|help)/, ["web-console"]],
  [/^packages\/resourceportal-web\/src\/components\/tenant-section-tabs\.tsx$/, ["web-console"]],
  [/^packages\/resourceportal-web\/package\.json$/, ["web-console"]],
  [/^scripts\/installer\/(firewall|diagnostics)\.sh$/, ["installer", "networking"]],
  [/^test\/installer\/test-(host-runtime|diagnostics)\.sh$/, ["installer"]],
  [/^scripts\/run-(device-vpn|gate)-dataplane-smoke\.sh$/, ["networking", "workflow"]],
  [/^config\/production\/stack\.yml\.tpl$/, ["networking"]],
  [/^\.github\/workflows\//, ["workflow"]],
  [/^scripts\/(fastfix-test-plan|release-validation-mode)\.mjs$/, ["workflow"]],
  [/^test\/(fastfix-test-plan|release-validation-mode)\.test\.mjs$/, ["workflow"]],
  [/^(package\.json|package-lock\.json)$/, ["dependency", "cli"]],
  [/^\.env\.example$/, []],
  [/^docs\//, []],
  [/^AGENTS\.md$/, []],
  [/^config\/release-milestones\.json$/, ["workflow"]],
];

export function selectProfiles(paths) {
  const profiles = new Set();
  const unclassified = [];
  for (const path of paths) {
    const entry = classifiers.find(([regex]) => regex.test(path));
    if (!entry) {
      unclassified.push(path);
      continue;
    }
    for (const profile of entry[1]) profiles.add(profile);
  }
  if (unclassified.length > 0) {
    throw new Error(
      "Fastfix has unclassified changes; add explicit targeted coverage or use milestone/full CI:\n" +
        unclassified.join("\n"),
    );
  }
  return {
    profiles: [...profiles].sort(),
    vpnSmoke: profiles.has("networking"),
    changedPaths: [...paths],
  };
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

if (process.argv[1]?.endsWith("fastfix-test-plan.mjs")) {
  const base = readArg("--base");
  const head = readArg("--head") ?? "HEAD";
  if (!base) throw new Error("--base is required (previous tag or PR base SHA)");
  const files = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRT", `${base}...${head}`],
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  const plan = selectProfiles(files);
  console.log(JSON.stringify(plan, null, 2));
  const output = readArg("--github-output");
  if (output) appendFileSync(output, `vpn_smoke=${plan.vpnSmoke}\n`);
  if (process.argv.includes("--run")) {
    const selected = new Map();
    for (const profile of plan.profiles) {
      for (const command of commands[profile]) {
        selected.set(JSON.stringify(command), command);
      }
    }
    for (const command of selected.values()) {
      console.log(`Targeted: ${command.join(" ")}`);
      const result = spawnSync(command[0], command.slice(1), {
        stdio: "inherit",
        env: process.env,
      });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
