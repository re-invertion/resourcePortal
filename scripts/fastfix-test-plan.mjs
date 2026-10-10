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
  "security": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/auth", "src/security", "src/mcp"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/security"],
  ],
  "tenant-access": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/tenants", "src/auth/github-security-regressions.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/tenant.final-routes.test.tsx"],
  ],
  "resource-bot": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/resource-bot"],
  ],
  "operations": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/operations"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/tenant.final-routes.test.tsx"],
  ],
  "observability": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/observability"],
  ],
  "egress": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/network-egress"],
  ],
  "identity": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/identity-providers", "src/auth/github-security-regressions.spec.ts"],
  ],
  "web-proxy": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "proxy-target.test.mjs"],
    ["node", "--check", "packages/resourceportal-web/server.mjs"],
  ],
  "runtime-config": [
    ["docker", "compose", "-f", "docker-compose.yml", "config", "--no-interpolate"],
  ],
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
  "help": [
    ["npm", "--workspace", "@resource-portal/help", "run", "build"],
    ["npm", "--workspace", "@resource-portal/help", "test"],
  ],
  "installer": [
    ["bash", "test/installer/test-host-runtime.sh"],
    ["bash", "test/installer/test-diagnostics.sh"],
    ["bash", "test/installer/test-core.sh"],
  ],
  // Previously covered by full real-Swarm and application CI. These individual
  // fixtures now also have explicit regression checks in patch releases.
  "release-fixtures": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/config/production-auth-entrypoints.spec.ts", "src/tenants"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "deployment-entrypoints.test.mjs", "src/pages/quota-payload.test.ts"],
    ["npm", "--workspace", "@resource-portal/sdk", "test"],
    ["node", "--check", "scripts/run-stage20-real-swarm-web-e2e.mjs"],
    ["bash", "test/installer/test-workflows.sh"],
    ["bash", "test/installer/test-core.sh"],
  ],
  "dependency": [["npm", "audit", "--audit-level=high"]],
  "workflow": [
    ["node", "--test", "test/fastfix-test-plan.test.mjs", "test/release-validation-mode.test.mjs", "test/test-catalog.test.mjs", "test/test-suite-registry.test.mjs", "test/test-selection.test.mjs", "test/test-workflow-gates.test.mjs"],
    ["node", "scripts/test-catalog.mjs"],
    ["bash", "-n", "scripts/run-device-vpn-dataplane-smoke.sh"],
  ],
  "mcp-oauth": [["npm", "run", "test:fastfix:mcp-oauth"]],
  "domains": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/domains/domains.service.spec.ts", "src/platform-dns/cloudflare-tenant-oauth.service.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/tenant-storage-pages.test.tsx"],
  ],
  "applications": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/app-groups/stage4-singleapp.spec.ts", "src/app-groups/sensitive-runtime-config.spec.ts", "src/app-groups/app-groups.view.spec.ts", "src/app-groups/single-app-logs.service.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/app-group/app-detail.test.tsx", "src/pages/app-group/create-app-wizard.test.tsx"],
  ],
  "bug-reports": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/bug-reports/bug-reports.service.spec.ts", "src/mcp/admin-mcp-protocol.service.spec.ts"],
  ],
  "platform-admin-ui": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/platform.final-routes.test.tsx"],
  ],
  "platform-release": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/platform-infrastructure/platform-release.service.spec.ts", "src/operations/executors/platform-release-update-operation.executor.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/platform.final-routes.test.tsx"],
    ["bash", "test/installer/test-releases.sh"],
    ["bash", "test/installer/test-control-plane.sh"],
    ["bash", "test/installer/test-packaging.sh"],
  ],
};

const classifiers = [
  [/^README\.md$/, ["workflow"]],
  [/^packages\/resourceportal-api\/scripts\/smoke-(deploy|stage11-quota-concurrency|stage15-capacity|stage16-operations|volume-lifecycle)\.ts$/, ["release-fixtures", "tenant-access", "platform-release"]],
  [/^packages\/resourceportal-api\/src\/config\/production-auth-entrypoints\.spec\.ts$/, ["release-fixtures", "identity"]],
  [/^packages\/resourceportal-web\/deployment-entrypoints\.test\.mjs$/, ["release-fixtures", "workflow"]],
  [/^scripts\/run-stage20-real-swarm-web-e2e\.mjs$/, ["release-fixtures", "platform-release"]],

  [/^config\/observability\//, ["observability"]],
  [/^docker-compose\.yml$/, ["runtime-config"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/(app-groups\.controller\.ts|app-groups\.module\.ts|single-app-logs\.service(\.spec)?\.ts)$/, ["applications"]],
  [/^packages\/resourceportal-api\/src\/identity-providers\//, ["identity"]],
  [/^packages\/resourceportal-api\/src\/network-egress\//, ["egress", "networking"]],
  [/^packages\/resourceportal-api\/src\/observability\//, ["observability"]],
  [/^packages\/resourceportal-api\/src\/operations\/operations\.repository\.ts$/, ["operations"]],
  [/^packages\/resourceportal-api\/src\/prisma\/raw-sql-policy\.spec\.ts$/, ["operations"]],
  [/^packages\/resourceportal-api\/src\/resource-bot\//, ["resource-bot"]],
  [/^packages\/resourceportal-api\/src\/tenants\//, ["tenant-access"]],
  [/^packages\/resourceportal-web\/(server|proxy-target(\.test)?)\.mjs$/, ["web-proxy"]],
  [/^packages\/resourceportal-api\/src\/networking\//, ["networking"]],
  [/^packages\/resourceportal-api\/src\/security\//, ["security"]],
  [/^packages\/resourceportal-web\/src\/security\//, ["security"]],
  [/^packages\/resourceportal-api\/scripts\/smoke-stage9-ingress\.ts$/, ["domains", "applications"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-usability\.test\.tsx$/, ["domains"]],
  [/^scripts\/verify-stage20-management-matrix\.mjs$/, ["platform-release", "platform-admin-ui"]],
  [/^packages\/resourceportal-api\/src\/(domains|platform-dns)\//, ["domains"]],
  [/^packages\/resourceportal-api\/src\/mcp\/admin-mcp-protocol\.service(\.spec)?\.ts$/, ["bug-reports", "platform-admin-ui"]],
  [/^packages\/resourceportal-api\/src\/mcp\//, ["mcp-oauth"]],
  [/^packages\/resourceportal-api\/src\/auth\//, ["mcp-oauth"]],
  [/^packages\/resourceportal-api\/src\/bug-reports\//, ["bug-reports"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/app-groups\.service\.ts$/, ["applications"]],
  [/^packages\/resourceportal-api\/src\/platform-infrastructure\//, ["platform-release"]],
  [/^packages\/resourceportal-api\/src\/operations\/executors\/platform-release-update-operation\.executor(\.spec)?\.ts$/, ["platform-release"]],
  [/^packages\/resourceportal-api\/src\/operations\/operation\.types\.ts$/, ["worker", "platform-release"]],
  [/^packages\/resourceportal-api\/src\/storage-backends\/storage-command-runner\.service\.ts$/, ["platform-release"]],
  [/^packages\/resourceportal-api\/src\/observability\/worker-runtime-observability/, ["worker"]],
  [/^packages\/resourceportal-api\/src\/(worker-execution.module|worker.runner)\.ts$/, ["worker", "platform-release"]],
  [/^packages\/resourceportal-api\/(prisma\/|src\/prisma\/seed\.ts)/, ["schema", "networking"]],
  [/^packages\/resourceportal-sdk\//, ["sdk"]],
  [/^packages\/resourceportal-cli\//, ["cli"]],
  [/^packages\/resourceportal-help\//, ["help"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-storage-pages(\.test)?\.tsx$/, ["domains"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-access-pages\.tsx$/, ["tenant-access"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-activity-pages\.tsx$/, ["operations"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-settings\.tsx$/, ["mcp-oauth"]],
  [/^packages\/resourceportal-web\/src\/pages\/app-group\/app-detail(\.test)?\.tsx$/, ["applications"]],
  [/^packages\/resourceportal-web\/src\/pages\/app-group\/create-app-wizard\.test\.tsx$/, ["applications"]],
  [/^packages\/resourceportal-web\/src\/pages\/(platform|platform-final-pages|platform-mcp|platform\.final-routes\.test)\.tsx$/, ["platform-admin-ui", "platform-release"]],
  [/^packages\/resourceportal-web\/src\/components\/shell\.tsx$/, ["platform-admin-ui"]],
  [/^packages\/resourceportal-web\/src\/pages\/(device-vpn|tenant-networking|help)/, ["web-console"]],
  [/^packages\/resourceportal-web\/src\/components\/tenant-section-tabs\.tsx$/, ["web-console"]],
  [/^packages\/resourceportal-web\/package\.json$/, ["web-console"]],
  [/^scripts\/installer\/(config|control-plane|identity|lifecycle|releases|smtp|upgrade)\.sh$/, ["platform-release", "installer"]],
  [/^scripts\/upgrade-recovery-from-0\.2\.68\.sh$/, ["platform-release", "installer"]],
  [/^test\/installer\/test-(releases|control-plane)\.sh$/, ["platform-release", "installer"]],
  [/^scripts\/installer\/(firewall|diagnostics)\.sh$/, ["installer", "networking"]],
  [/^test\/installer\/test-workflows\.sh$/, ["workflow"]],
  [/^test\/installer\/test-(host-runtime|diagnostics|core)\.sh$/, ["installer"]],
  [/^scripts\/run-(device-vpn|gate)-dataplane-smoke\.sh$/, ["networking", "workflow"]],
  [/^config\/production\/stack\.yml\.tpl$/, ["networking", "platform-release"]],
  [/^Dockerfile$/, ["platform-release"]],
  [/^\.github\/workflows\//, ["workflow"]],
  [/^scripts\/(fastfix-test-plan|release-validation-mode|test-catalog|run-test-suite|test-selection|test-matrix)\.mjs$/, ["workflow"]],
  [/^test\/.*\.test\.mjs$/, ["workflow"]],
  [/^config\/test-(suites|migrations)\.json$/, ["workflow"]],
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
    // Mandatory for every patch; scoped tests must never suppress dependency audit.
    selected.set("mandatory-dependency-audit", ["npm", "audit", "--audit-level=high"]);
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