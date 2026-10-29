import { test } from "node:test";
import { strict as assert } from "node:assert";
import { selectProfiles } from "../scripts/fastfix-test-plan.mjs";

test("new Gate Swarm sysctl smoke is classified and validated, unknown scripts still fail closed", () => {
  const plan=selectProfiles(["scripts/run-remote-lan-gateway-sysctl-swarm-smoke.sh"]);
  assert.deepEqual(plan.profiles, ["networking","workflow"]);
  assert.equal(plan.vpnSmoke,true);
  assert.equal(plan.swarmSmoke,true);
  assert.throws(()=>selectProfiles(["scripts/run-unregistered-swarm-smoke.sh"]),/unclassified changes/);
});

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
  const plan = selectProfiles(["docs/advanced-networking-resourceportalgate.md", "packages/resourceportal-api/README.md"]);
  assert.deepEqual(plan.profiles, []);
  assert.equal(plan.vpnSmoke, false);
  assert.equal(plan.swarmSmoke, false);
});

test("tenant OIDC and native-login changes select the dedicated identity/federation gate", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/tenant-oidc/tenant-oidc.service.ts",
    "packages/resourceportal-api/src/oauth-applications/tenant-oauth-project.spec.ts",
    "packages/resourceportal-api/src/api.module.ts",
    "packages/resourceportal-api/scripts/tenant-oidc-live-preflight.mjs",
    "packages/resourceportal-web/src/pages/tenant-identity-sso.tsx",
    "packages/resourceportal-web/src/pages/platform-identity-pages.tsx",
  ]);
  assert.deepEqual(plan.profiles, ["identity"]);
  assert.equal(plan.vpnSmoke, false);
});

test("real ZITADEL federation browser and projection helpers require identity and security gates", () => {
  const plan = selectProfiles([
    "scripts/run-federation-browser-e2e.mjs",
    "scripts/federation-zitadel-user-projection.mjs",
  ]);
  assert.deepEqual(plan.profiles, ["identity", "security"]);
  assert.equal(plan.vpnSmoke, false);
});

test("tenant OIDC readiness health files require identity and platform release regression", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/health/health.controller.ts",
    "packages/resourceportal-api/src/health/health.controller.spec.ts",
    "packages/resourceportal-api/src/health/health.module.ts",
  ]);
  assert.deepEqual(plan.profiles, ["identity", "platform-release"]);
  assert.equal(plan.vpnSmoke, false);
});

test("live HTTPS tenant OIDC integration scripts and fixtures are release-gated", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/scripts/tenant-oidc-live-e2e.ts",
    "packages/resourceportal-api/scripts/tenant-oidc-browser-e2e.ts",
    "scripts/run-tenant-oidc-https-e2e.sh",
    "test/tenant-oidc/docker-compose.yml",
  ]);
  assert.deepEqual(plan.profiles, ["identity", "workflow"]);
  assert.equal(plan.vpnSmoke, false);
});

test("identity rollout cannot silently bypass patch validation when package manifest changes", () => {
  const plan = selectProfiles(["packages/resourceportal-api/package.json"]);
  assert.deepEqual(plan.profiles, ["identity", "workflow"]);
});

test("real database rollback smoke changes require the platform release regression gate", () => {
  const plan = selectProfiles([
    "scripts/release-rollback-policy.mjs",
    "scripts/run-automatic-rollback-smoke.sh",
    "test/test-upgrade-database-rollback.test.mjs",
  ]);
  assert.deepEqual(plan.profiles, ["platform-release", "workflow"]);
});

test("API HTTP entrypoint changes always execute security, worker and container terminal regressions", () => {
  const plan = selectProfiles(["packages/resourceportal-api/src/main.ts"]);
  assert.deepEqual(plan.profiles, ["container-terminal", "platform-release", "security", "worker"]);
  assert.equal(plan.vpnSmoke, false);
});

test("Swarm interactive terminal files select explicit security, worker, app and release gates", () => {
  const files = [
    "packages/resourceportal-api/scripts/smoke-container-terminal.ts",
    "packages/resourceportal-api/src/terminal/container-terminal.service.spec.ts",
    "packages/resourceportal-api/src/terminal/container-terminal.service.ts",
    "packages/resourceportal-api/src/terminal/swarm-terminal-router.spec.ts",
    "packages/resourceportal-api/src/terminal/swarm-terminal-router.ts",
    "packages/resourceportal-api/src/terminal/terminal-agent.runner.spec.ts",
    "packages/resourceportal-api/src/terminal/terminal-agent.runner.ts",
    "packages/resourceportal-api/src/terminal/terminal-worker.spec.ts",
    "packages/resourceportal-api/src/terminal/terminal-worker.ts",
    "packages/resourceportal-web/src/pages/app-group/application-terminal.tsx",
  ];
  const plan = selectProfiles(files);
  for (const needed of ["container-terminal", "security", "worker", "applications", "platform-release", "workflow", "tenant-ux-patch"]) {
    assert.ok(plan.profiles.includes(needed), `${needed} is a required terminal release profile`);
  }
  assert.equal(plan.vpnSmoke, false, "PTY changes must not be mislabeled as VPN");
  assert.equal(plan.swarmSmoke, true, "PTY / one-shot exec changes require isolated real Docker Swarm");
  assert.throws(() => selectProfiles(["packages/resourceportal-api/src/terminal-cli/host.ts"]), /unclassified changes/);
});

test("Operation repository regressions are explicitly gated in patch releases (#365)", () => {
  const paths = [
    "packages/resourceportal-api/src/operations/operations.repository.ts",
    "packages/resourceportal-api/src/operations/operations.repository.spec.ts",
  ];
  assert.deepEqual(selectProfiles(paths).profiles, ["operations"]);
  assert.throws(() => selectProfiles(["packages/resourceportal-api/src/operations/operations.repository.other.ts"]), /unclassified changes/);
});

test("SingleApp restart implementation and regression files select operations, app and worker tests (#365)", () => {
  const paths = [
    "packages/resourceportal-api/src/app-groups/app-group-runtime-operations.service.ts",
    "packages/resourceportal-api/src/app-groups/single-app-restart-dedup.spec.ts",
    "packages/resourceportal-api/src/operations/executors/runtime-operation.executor.ts",
    "packages/resourceportal-api/src/operations/executors/runtime-operation.executor.spec.ts",
    "packages/resourceportal-api/src/operations/operations-worker.service.ts",
    "packages/resourceportal-api/src/operations/operations-worker.service.spec.ts",
    "packages/resourceportal-api/src/operations/operations.service.ts",
  ];
  const plan = selectProfiles(paths);
  assert.deepEqual(plan.profiles, ["applications", "operations", "worker"]);
  assert.equal(plan.vpnSmoke, false);
  assert.throws(() => selectProfiles(["packages/resourceportal-api/src/operations/other-runtime.ts"]), /unclassified changes/);
});

test("Worker startup-order regression is explicitly classified for restart safety (#365)", () => {
  const plan = selectProfiles(["packages/resourceportal-api/src/worker-startup-resync.spec.ts"]);
  assert.deepEqual(plan.profiles, ["operations", "platform-release", "worker"]);
  assert.equal(plan.vpnSmoke, false);
  assert.throws(() => selectProfiles(["packages/resourceportal-api/src/worker-startup-other.spec.ts"]), /unclassified changes/);
});

test("security runtime changes select security tests (never silently skipped)", () => {
  assert.deepEqual(selectProfiles(["packages/resourceportal-api/src/security/new-auth.ts"]).profiles, ["security"]);
});
test("managed Gate Python regression files select mandatory real networking coverage", async () => {
  const paths = ["test/test_gate_managed_uplink.py", "test/test_gate_uplink_installer.py", "test/test_gate_native_nm_uplink.py"];
  const plan = selectProfiles(paths);
  assert.deepEqual(plan.profiles, ["networking"]);
  assert.equal(plan.vpnSmoke, true);
  // Only those two reviewed files are registered. Unknown root scripts still fail closed.
  assert.throws(() => selectProfiles(["test/test_gate_unreviewed.py"]), /unclassified changes/);
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(new URL("../scripts/fastfix-test-plan.mjs", import.meta.url), "utf8");
  assert.match(script, /\["python3", "-m", "unittest", "discover", "-s", "test", "-p", "test_gate\*\.py", "-v"\]/);
});
test("production Gate installer image packages both runtime Python assets", async () => {
  const { readFileSync } = await import("node:fs");
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  for (const name of ["gate-lan-agent.py", "gate-managed-uplink.py"]) {
    assert.ok(dockerfile.includes(
      `COPY packages/resourceportal-api/src/networking/${name} ./dist/src/networking/${name}`
    ), `${name} must be colocated with the compiled gate-installer module`);
  }
});
test("unregistered root-level changes still fail closed", () => {
  assert.throws(() => selectProfiles(["new-unmapped-runtime/entry.ts"]), /unclassified changes/);
});
test("unregistered API and Web modules fail closed instead of bypassing runtime coverage", () => {
  assert.throws(
    () => selectProfiles(["packages/resourceportal-api/src/new-vpn/device-vpn.ts"]),
    /unclassified changes/,
  );
  assert.throws(
    () => selectProfiles(["packages/resourceportal-web/src/new-network/route.tsx"]),
    /unclassified changes/,
  );
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
    "installer",
    "networking",
    "platform-admin-ui",
    "platform-release",
    "volume-safety",
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


test("security and infrastructure hardening selects explicit release gates", () => {
  const plan = selectProfiles([
    "config/observability/docker-stack.yml",
    "docker-compose.yml",
    "packages/resourceportal-api/src/app-groups/app-groups.controller.ts",
    "packages/resourceportal-api/src/identity-providers/zitadel-identity-provider.service.ts",
    "packages/resourceportal-api/src/network-egress/egress-guard.runner.ts",
    "packages/resourceportal-api/src/observability/observability.controller.ts",
    "packages/resourceportal-api/src/operations/operations.repository.ts",
    "packages/resourceportal-api/src/prisma/raw-sql-policy.spec.ts",
    "packages/resourceportal-api/src/resource-bot/resource-bot-billing.service.ts",
    "packages/resourceportal-api/src/tenants/tenants.service.ts",
    "packages/resourceportal-web/server.mjs",
  ]);
  assert.equal(plan.vpnSmoke, true);
  assert.deepEqual(plan.profiles, [
    "applications",
    "egress",
    "identity",
    "networking",
    "observability",
    "operations",
    "resource-bot",
    "runtime-config",
    "tenant-access",
    "web-proxy",
  ]);
});


test("app creation wizard test is classified in release scopes", () => {
  const plan = selectProfiles(["packages/resourceportal-web/src/pages/app-group/create-app-wizard.test.tsx"]);
  assert.deepEqual(plan.profiles, ["applications"]);
});


test("BusyBox installer hotfix executes upgrade and control-plane regression coverage", () => {
  const plan = selectProfiles([
    "scripts/installer/control-plane.sh",
    "scripts/installer/identity.sh",
    "scripts/installer/lifecycle.sh",
    "scripts/installer/smtp.sh",
    "scripts/installer/upgrade.sh",
    "scripts/upgrade-recovery-from-0.2.68.sh",
    "test/installer/test-releases.sh",
    "test/installer/test-control-plane.sh",
  ]);
  assert.equal(plan.vpnSmoke, true);
  assert.deepEqual(plan.profiles, ["installer", "networking", "platform-release"]);
});
test("installer configuration fixes select the core safety suite", () => {
  assert.deepEqual(selectProfiles(["scripts/installer/config.sh", "test/installer/test-core.sh"]).profiles, ["installer", "platform-release"]);
});
test("the fastfix runner requires a dependency security audit for all releases", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../scripts/fastfix-test-plan.mjs", import.meta.url), "utf8");
  assert.match(source, /selected\.set\("mandatory-dependency-audit", \["npm", "audit", "--audit-level=high"\]\)/);
});


test("retired Codespaces, quota fixtures and browser Swarm E2E have explicit patch checks", () => {
  const plan = selectProfiles([
    "README.md",
    "packages/resourceportal-api/scripts/smoke-deploy.ts",
    "packages/resourceportal-api/scripts/smoke-stage11-quota-concurrency.ts",
    "packages/resourceportal-api/scripts/smoke-stage15-capacity.ts",
    "packages/resourceportal-api/scripts/smoke-stage16-operations.ts",
    "packages/resourceportal-api/scripts/smoke-volume-lifecycle.ts",
    "packages/resourceportal-api/src/config/production-auth-entrypoints.spec.ts",
    "packages/resourceportal-web/deployment-entrypoints.test.mjs",
    "scripts/run-stage20-real-swarm-web-e2e.mjs",
  ]);
  assert.deepEqual(plan.profiles, [
    "identity", "platform-release", "release-fixtures",
    "tenant-access", "workflow",
  ]);
  assert.equal(plan.vpnSmoke, false);
});

test("unregistered release fixtures still fail closed", () => {
  assert.throws(() => selectProfiles([
    "packages/resourceportal-api/scripts/smoke-new-unknown.ts",
  ]), /unclassified changes/);
});

test("rollback release paths require explicit scoped tests, including legacy installer contracts", () => {
  const plan = selectProfiles([
    "config/production/release-manifest.schema.json",
    "scripts/release-rollback-policy.mjs",
    "test/installer/test-v020-placement-networking.sh",
    "test/installer/test-zitadel-management.sh",
  ]);
  assert.deepEqual(plan.profiles, ["identity", "installer", "networking", "platform-release", "workflow"]);
  assert.equal(plan.vpnSmoke, true);
});

test("multihomed Site VPN discovery helper must run in explicit networking and rollback gates", async () => {
  const plan = selectProfiles(["test/installer/test-remote-lan-gate-agent.py"]);
  assert.deepEqual(plan.profiles, ["networking", "platform-release"]);
  assert.equal(plan.vpnSmoke, true);
  const { readFileSync } = await import("node:fs");
  const planner = readFileSync(new URL("../scripts/fastfix-test-plan.mjs", import.meta.url), "utf8");
  assert.match(planner, /\["python3", "test\/installer\/test-remote-lan-gate-agent\.py"\]/);
});

test("SingleApp placement-networking assertions require release and VPN integration gates", async () => {
  const path = "packages/resourceportal-api/src/internal/v020-placement-networking.spec.ts";
  const plan = selectProfiles([path]);
  assert.deepEqual(plan.profiles, ["networking", "platform-release"]);
  assert.equal(plan.vpnSmoke, true);
  const { readFileSync } = await import("node:fs");
  const planner = readFileSync(new URL("../scripts/fastfix-test-plan.mjs", import.meta.url), "utf8");
  assert.match(planner, /"src\/networking", "src\/internal\/v020-placement-networking\.spec\.ts"/);
});

test("placement-networking fixture must select live VPN dataplane coverage", () => {
  const plan = selectProfiles(["test/installer/test-v020-placement-networking.sh"]);
  assert.ok(plan.profiles.includes("networking"));
  assert.ok(plan.profiles.includes("platform-release"));
  assert.equal(plan.vpnSmoke, true);
});


test("security issue patches cannot skip quota, worker or registry SSRF regressions", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/registries/registry-ping.ts",
    "packages/resourceportal-api/src/registries/registry-ping.spec.ts",
    "packages/resourceportal-api/src/app-groups/app-group-manifest.service.ts",
    "packages/resourceportal-api/src/app-groups/cpu-quota-validation.spec.ts",
    "packages/resourceportal-api/src/internal/deployment-execution.service.ts",
    "packages/resourceportal-api/src/internal/deployment-cpu-validation.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["deployment-rollout", "quota-security", "registry-auth", "registry-validation", "worker"]);
  assert.equal(plan.vpnSmoke, false);
});


test("custom-domain ownership changes select deployment and ingress regression coverage", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/domains/domain-publication.ts",
    "packages/resourceportal-api/src/internal/deployment-domain-ownership.spec.ts",
    "packages/resourceportal-api/src/internal/ingress-reconciler.service.ts",
  ]);
  assert.deepEqual(plan.profiles, ["domains"]);
});


test("volume deletion and draft attachment changes cannot skip active-mount regression tests", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/volumes/deployed-volume-reference.ts",
    "packages/resourceportal-api/src/volumes/volumes.service.ts",
    "packages/resourceportal-api/src/app-groups/app-groups.service.ts",
  ]);
  assert.deepEqual(plan.profiles, ["applications", "volume-safety"]);
});


test("per-deployment registry authentication has its own mandatory patch regression gate", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/internal/stack-registry-auth.service.ts",
    "packages/resourceportal-api/src/internal/stack-apply.service.ts",
    "packages/resourceportal-api/src/internal/deployment-registry-isolation.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["deployment-rollout", "registry-auth"]);
});


test("local storage adapter permission hardening always selects storage isolation tests", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.ts",
    "packages/resourceportal-api/src/storage-backends/local-filesystem-storage-adapter.service.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["storage-isolation"]);
});

test("cross-cutting issue fix selects strict billing/recovery/storage/volume/web profiles", () => {
  const paths = [
    "packages/resourceportal-api/src/billing/billing-worker.service.ts",
    "packages/resourceportal-api/src/billing/billing-preflight.guard.spec.ts",
    "packages/resourceportal-api/src/disaster-recovery/runtime-restore.service.ts",
    "packages/resourceportal-api/src/internal/runtime-drift-reconciler.pagination.spec.ts",
    "packages/resourceportal-api/src/storage-backends/shared-nfs-probe.ts",
    "packages/resourceportal-api/src/internal/stack-volume-provisioner.service.ts",
    "packages/resourceportal-api/src/operations/executors/volume-operation.executors.ts",
    "packages/resourceportal-api/src/volumes/volume-usage-reconciler.service.spec.ts",
    "packages/resourceportal-web/src/hooks/use-api.test.tsx",
    "packages/resourceportal-web/src/pages/volume-operation-tracker.ts",
    "packages/resourceportal-web/src/pages/app-group/app-edit.test.tsx",
    "packages/resourceportal-web/src/pages/tenant-resources.tsx",
  ];
  const result = selectProfiles(paths);
  assert.deepEqual(result.profiles, [
    "billing-correctness", "cross-node-storage", "reactive-web-state",
    "recovery-safety", "volume-operations",
  ]);
  assert.equal(result.changedPaths.length, paths.length);
});

test("unclassified changes still fail closed despite cross-cutting profiles", () => {
  assert.throws(
    () => selectProfiles(["packages/resourceportal-api/src/unknown-risk-module/untested.ts"]),
    /Fastfix has unclassified changes/,
  );
});

test("release rollback guard and Swarm smoke cannot be omitted from Fast Fix selection", () => {
  const plan = selectProfiles(["scripts/release-rollback-policy.mjs", "scripts/run-automatic-rollback-smoke.sh", "scripts/rollback-zitadel-runtime.sh", "scripts/publish-tested-release-image.sh"]);
  assert.deepEqual(plan.profiles, ["platform-release", "workflow"]);
});

test("API production build config is classified and retains narrow E2E-only exclusions", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const config = JSON.parse(readFileSync(new URL("../packages/resourceportal-api/tsconfig.build.json", import.meta.url), "utf8"));
  const excludedScripts = config.exclude.filter((path) => path.startsWith("scripts/")).sort();
  assert.deepEqual(excludedScripts, [
    "scripts/tenant-oidc-browser-e2e.ts",
    "scripts/tenant-oidc-live-e2e.ts",
  ]);
  assert.ok(!config.exclude.some((path) => path === "scripts" || path === "src" || path === "src/**"));
  for (const path of excludedScripts) {
    assert.ok(existsSync(fileURLToPath(new URL(`../packages/resourceportal-api/${path}`, import.meta.url))));
  }
  assert.deepEqual(selectProfiles(["packages/resourceportal-api/tsconfig.build.json"]).profiles, ["identity", "workflow"]);
  assert.throws(() => selectProfiles(["packages/resourceportal-api/tsconfig.unregistered.json"]), /unclassified changes/);
});

test("deployment runtime patch selects targeted rollout and mount regressions", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/internal/stack-rollout.service.ts",
    "packages/resourceportal-api/src/internal/explicit-rollback-completion.spec.ts",
    "packages/resourceportal-api/src/internal/stack-rollout.service.spec.ts",
    "packages/resourceportal-api/src/internal/deployment-mount-paths.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["deployment-rollout", "gpu-security"]);
});


test("deployment execution changes always run mount overlap regressions", () => {
  const plan = selectProfiles(["packages/resourceportal-api/src/internal/deployment-execution.service.ts"]);
  assert.ok(plan.profiles.includes("deployment-rollout"));
});

test("stack apply changes always run deployment rollout and auth regressions", () => {
  const plan = selectProfiles(["packages/resourceportal-api/src/internal/stack-apply.service.ts"]);
  assert.ok(plan.profiles.includes("deployment-rollout"));
  assert.ok(plan.profiles.includes("registry-auth"));
});


test("LAN Attachment DHCP smoke and capability helper select security regression gates", () => {
  const plan = selectProfiles([
    "scripts/run-remote-lan-l2-dhcp-smoke.sh",
    "test/installer/test-remote-lan-dhcp.py",
    "test/installer/test-swarm-required-capabilities.sh",
  ]);
  assert.equal(plan.vpnSmoke, true);
  assert.ok(plan.profiles.includes("networking"));
  assert.ok(plan.profiles.includes("installer"));
  assert.ok(plan.profiles.includes("platform-release"));
});

test("voucher expiry fixture changes require full billing correctness profile", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/billing/billing-voucher-codes.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["billing-correctness"]);
  assert.equal(plan.vpnSmoke, false);
});

test("historical Workspace merge author maps to canonical maintainer only in presentation", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const canonicalize = (contact) => execFileSync("git", [
    "check-mailmap", contact,
  ], { cwd, encoding: "utf8" }).trim();
  assert.equal(
    canonicalize("ResourcePortal Workspace <workspace@users.noreply.github.com>"),
    "Patryk Rusak <90280457+P4tkry@users.noreply.github.com>",
  );
  assert.equal(
    canonicalize("Agent Workspace <agent-workspace@local>"),
    "Agent Workspace <agent-workspace@local>",
  );
  assert.deepEqual(selectProfiles([".mailmap"]).profiles, ["workflow"]);
});


test("GPU change is classified and requires physical NVIDIA Swarm security gate", () => {
  const cases = [
    "packages/resourceportal-api/src/platform-infrastructure/nvidia-gpu-node-probe.ts",
    "packages/resourceportal-api/src/platform-infrastructure/swarm-gpu-node-probe-router.spec.ts",
    "packages/resourceportal-api/src/internal/nvidia-gpu-swarm-render.spec.ts",
    "packages/resourceportal-api/src/internal/nvidia-gpu-deployment-validation.spec.ts",
    "packages/resourceportal-api/src/app-groups/nvidia-gpu-deployment-snapshot.spec.ts",
    "packages/resourceportal-api/scripts/render-nvidia-gpu-stack-fixture.ts",
    "packages/resourceportal-api/src/internal/nvidia-gpu-app-group-teardown.spec.ts",
    "packages/resourceportal-api/src/app-groups/nvidia-gpu-draft-discard.spec.ts",
    "packages/resourceportal-api/src/app-groups/nvidia-gpu-identity-immutable.spec.ts",
    "packages/resourceportal-api/src/internal/nvidia-gpu-rollout-cleanup.spec.ts",
    "packages/resourceportal-api/src/internal/nvidia-gpu-release-admission.spec.ts",
    "packages/resourceportal-api/src/internal/stack-rollout.service.ts",
    "packages/resourceportal-web/src/pages/platform-gpu-permissions.test.tsx",
    "scripts/test-nvidia-gpu-swarm.sh",
    "scripts/run-real-swarm-smoke.sh",
    "test/installer/test-gpu-readiness.sh",
    "test/installer/test-gpu-swarm-gate-safety.sh",
    "packages/resourceportal-api/src/internal/stack-runtime.service.ts",
    "packages/resourceportal-api/src/operations/executors/app-group-delete-operation.executor.ts",
  ];
  const plan = selectProfiles(cases);
  assert.equal(plan.gpuSmoke, true);
  assert.equal(plan.swarmSmoke, true, "GPU runtime changes require the isolated real Docker Swarm gate");
  assert.ok(plan.profiles.includes("gpu-security"));
  assert.ok(plan.profiles.includes("platform-release"));
  assert.throws(() => selectProfiles(["scripts/unregistered-nvidia-test.sh"]), /unclassified changes/);
});

test("shared installer image-pull helper requires upgrade and complete installer coverage (#366)", () => {
  const plan = selectProfiles(["scripts/installer/common.sh"]);
  assert.ok(plan.profiles.includes("upgrade-recovery"));
  assert.ok(plan.profiles.includes("installer"));
  assert.ok(plan.profiles.includes("platform-release"));
});


test("terminal release readiness mandates real Swarm while preserving other required gates", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../.github/workflows/release-readiness.yml", import.meta.url), "utf8");
  assert.match(workflow, /swarm_smoke: \$\{\{ steps\.test-plan\.outputs\.swarm_smoke \}\}/);
  assert.match(workflow, /if: needs\.candidate\.outputs\.mode == 'milestone' \|\| needs\.candidate\.outputs\.swarm_smoke == 'true'/);
  assert.match(workflow, /if \[\[ "\$MODE" == milestone \|\| "\$SWARM_SMOKE" == true \]\]; then/);
  assert.match(workflow, /verify_gate swarm "\$SWARM" true/);
  assert.match(workflow, /verify_gate installer "\$INSTALLER" true/);
});


test("capacity and stage11 quota changes select explicit patch regressions (#373/#370)", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/capacity/capacity-preflight.service.ts",
    "packages/resourceportal-api/src/capacity/capacity-preflight.service.spec.ts",
    "packages/resourceportal-api/src/app-groups/stage11-app-groups.service.ts",
    "packages/resourceportal-api/src/app-groups/stage11-quota-drift.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["applications", "quota-security"]);
  assert.equal(plan.vpnSmoke, false);
  assert.throws(
    () => selectProfiles(["packages/resourceportal-api/src/app-groups/unregistered-quota.ts"]),
    /unclassified changes/,
  );
});

test("Service Identity authorization changes require identity and security regressions (#321)", () => {
  const plan = selectProfiles([
    "packages/resourceportal-api/src/service-identities/service-identities.service.ts",
    "packages/resourceportal-api/src/service-identities/service-identity-credentials.service.ts",
    "packages/resourceportal-api/src/service-identities/service-identity-role-grants.spec.ts",
  ]);
  assert.deepEqual(plan.profiles, ["identity", "security"]);
});
