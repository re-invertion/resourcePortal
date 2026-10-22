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
  "upgrade-recovery": [
    ["node", "--test", "test/installer/test-target-upgrade.test.mjs", "test/installer/test-upgrade-preflight.test.mjs", "test/installer/test-upgrade-recovery.test.mjs"],
    ["bash", "-n", "scripts/installer/target-upgrade.sh"],
    ["bash", "-n", "scripts/installer/recovery.sh"],
    ["bash", "-n", "scripts/upgrade-recovery-from-0.2.78.sh"],
  ],
  "billing-correctness": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/billing"],
  ],
  "recovery-safety": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/disaster-recovery", "src/internal/runtime-drift-reconciler.pagination.spec.ts"],
  ],
  "cross-node-storage": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/storage-backends", "src/internal/stack-volume-provisioner.service.spec.ts"],
    ["bash", "test/installer/test-nfs.sh"],
  ],
  "volume-operations": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/volumes", "src/operations/executors/volume-operation.executors.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/volume-operation-tracker.test.ts", "src/pages/tenant-storage-pages.test.tsx"],
  ],
  "reactive-web-state": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/App.test.tsx", "src/hooks/use-api.test.tsx", "src/pages/app-group/app-edit.test.tsx", "src/pages/billing-funding-ui.test.tsx", "src/pages/machine-credential-rotation.test.tsx"],
  ],
  "storage-isolation": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/storage-backends/local-filesystem-storage-adapter.service.spec.ts"],
  ],
  "registry-auth": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/internal/stack-registry-auth.service.spec.ts", "src/internal/stack-apply.service.spec.ts", "src/internal/deployment-registry-isolation.spec.ts", "src/internal/isolated-docker-context.spec.ts"],
  ],
  "deployment-rollout": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--",
      "src/internal/stack-rollout.service.spec.ts",
      "src/internal/deployment-mount-paths.spec.ts",
      "src/internal/stack-runtime-observed.spec.ts"],
  ],
  "volume-safety": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/volumes/stage7-volume-lifecycle.spec.ts", "src/volumes/deployed-volume-reference.spec.ts", "src/volumes/stage14-volume-backend.spec.ts", "src/app-groups/volume-attachment-race.spec.ts"],
  ],
  "quota-security": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/app-groups/app-group-manifest.spec.ts", "src/app-groups/app-group-manifest.service.spec.ts", "src/app-groups/cpu-quota-validation.spec.ts", "src/internal/deployment-cpu-validation.spec.ts"],
  ],
  "registry-validation": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/registries/registries.service.spec.ts", "src/registries/registry-ping.spec.ts"],
  ],
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
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/identity-providers", "src/tenant-oidc", "src/oauth-applications/redirect-uri.spec.ts", "src/oauth-applications/tenant-oauth-project.spec.ts", "src/auth/github-security-regressions.spec.ts", "src/auth/native-only-login.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/tenant-identity-sso.test.tsx", "src/pages/tenant-access-pages.test.tsx"],
    ["node", "--check", "packages/resourceportal-api/scripts/tenant-oidc-live-preflight.mjs"],
    ["bash", "-n", "scripts/run-tenant-oidc-https-e2e.sh"],
  ],
  "web-proxy": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "proxy-target.test.mjs"],
    ["node", "--check", "packages/resourceportal-web/server.mjs"],
  ],
  "runtime-config": [
    ["docker", "compose", "-f", "docker-compose.yml", "config", "--no-interpolate"],
  ],
  "networking": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--",
      "src/networking", "src/internal/v020-placement-networking.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/device-vpn-panel.test.tsx", "src/pages/tenant-networking.test.tsx", "src/pages/tenant-networking-bgp.test.tsx"],
    ["bash", "test/installer/test-host-runtime.sh"],
    ["python3", "test/installer/test-gate-discovery-multilan.py"],
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
    ["bash", "test/installer/test-v020-placement-networking.sh"],
    ["bash", "test/installer/test-zitadel-management.sh"],
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
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/domains/domains.service.spec.ts", "src/domains/domain-publication.spec.ts", "src/internal/deployment-domain-ownership.spec.ts", "src/internal/ingress-reconciler.service.spec.ts", "src/platform-dns/cloudflare-tenant-oauth.service.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/tenant-storage-pages.test.tsx"],
  ],
  "applications": [
    ["npm", "--workspace", "@resource-portal/api", "test", "--", "src/app-groups/stage4-singleapp.spec.ts", "src/app-groups/sensitive-runtime-config.spec.ts", "src/app-groups/app-groups.view.spec.ts", "src/app-groups/single-app-logs.service.spec.ts"],
    ["npm", "--workspace", "@resource-portal/web", "test", "--", "src/pages/app-group/app-detail.test.tsx", "src/pages/app-group/create-app-wizard.test.tsx"],
  ],
  "tenant-ux-patch": [
    ["npm", "--workspace", "@resource-portal/web", "test", "--",
      "src/pages/applications.test.tsx", "src/pages/app-group/route.test.tsx",
      "src/pages/app-group/create-app-wizard.test.tsx", "src/pages/app-group/app-detail.test.tsx",
      "src/pages/app-group/networking.test.tsx", "src/pages/app-group/config-code-preview.test.tsx", "src/pages/tenant-access-pages.test.tsx",
      "src/pages/tenant-dashboard.test.tsx", "src/pages/tenant-settings.test.tsx",
      "src/pages/tenant-storage-pages.test.tsx", "src/pages/tenant-operation-fixes.test.tsx",
      "src/pages/tenant-branding.test.tsx", "src/pages/domain-assignment.test.tsx",
      "src/pages/network-status-display.test.ts", "src/lib/billing-display.test.ts",
      "src/lib/compute-estimate.test.ts", "src/lib/role-capabilities.test.ts"],
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
    ["bash", "test/installer/test-v020-placement-networking.sh"],
    ["bash", "test/installer/test-zitadel-management.sh"],
    ["node", "--test", "test/test-release-rollback-policy.test.mjs", "test/test-upgrade-database-rollback.test.mjs"],
  ],
};

const classifiers = [
  // Tenant IdP, OIDC clients and login migration are identity/security-critical.
  // Explicitly classify every new surface, including new tests and the API
  // package manifest, so patch selection cannot silently omit these gates.
  [/^packages\/resourceportal-api\/src\/tenant-oidc\//, ["identity"]],
  [/^packages\/resourceportal-api\/src\/oauth-applications\//, ["identity"]],
  [/^packages\/resourceportal-api\/src\/api\.module\.ts$/, ["identity"]],
  // Installer-facing tenant OIDC health readiness is identity and release-critical.
  [/^packages\/resourceportal-api\/src\/health\/health\.(?:controller(?:\.spec)?|module)\.ts$/, ["identity", "platform-release"]],
  [/^packages\/resourceportal-api\/package\.json$/, ["identity", "workflow"]],
  // Production TypeScript build config changes require identity and workflow
  // regression coverage; release readiness separately runs the full API build.
  [/^packages\/resourceportal-api\/tsconfig\.build\.json$/, ["identity", "workflow"]],
  [/^packages\/resourceportal-api\/scripts\/tenant-oidc-live-preflight\.mjs$/, ["identity"]],
  [/^packages\/resourceportal-api\/scripts\/tenant-oidc-(?:live|browser)-e2e\.ts$/, ["identity"]],
  [/^scripts\/run-tenant-oidc-https-e2e\.sh$/, ["identity", "workflow"]],
  [/^test\/tenant-oidc\/.*\.ya?ml$/, ["identity", "workflow"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-identity-sso(?:\.test)?\.tsx$/, ["identity"]],
  [/^packages\/resourceportal-web\/src\/pages\/platform-identity-pages\.tsx$/, ["identity"]],
  // Shared App Group runtime blockers feed both standard views and topology;
  // changes must run application AND networking regressions in Fast Fix.
  [/^packages\/resourceportal-api\/src\/app-groups\/app-groups\.view\.ts$/, ["applications", "networking"]],
  // Explicit coverage for the tenant usability patch: new files must not
  // silently bypass fast-fix validation on non-milestone releases.
  [/^packages\/resourceportal-api\/src\/billing\/(?:billing\.service|tenant-estimate-rates\.spec)\.ts$/, ["billing-correctness"]],
  [/^packages\/resourceportal-web\/src\/(?:App\.tsx|components\/billing-usage-charts\.tsx)$/, ["tenant-ux-patch"]],
  [/^packages\/resourceportal-web\/src\/lib\/(?:billing-display|compute-estimate|role-capabilities)(?:\.test)?\.ts$/, ["tenant-ux-patch"]],
  [/^packages\/resourceportal-web\/src\/pages\/(?:applications|tenant-dashboard|tenant-access-pages|tenant-branding|tenant-operation-fixes|domain-assignment|network-status-display)(?:\.test)?\.tsx?$/, ["tenant-ux-patch"]],
  // Tenant volume reads and detailed attachments exercise the actual backend
  // volume suite as well as the tenant storage component regression.
  [/^packages\/resourceportal-api\/src\/volumes\/volume-read\.service(?:\.spec)?\.ts$/, ["volume-operations"]],
  // New syntax-aware config preview and MCP catalog safeguards must never
  // silently skip frontend regression checks on fast-fix releases.
  [/^packages\/resourceportal-web\/src\/pages\/app-group\/(?:config|config-code-preview\.test)\.tsx$/, ["tenant-ux-patch"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant-settings\.test\.tsx$/, ["tenant-ux-patch", "mcp-oauth"]],
  [/^packages\/resourceportal-web\/src\/pages\/tenant\.tsx$/, ["tenant-ux-patch"]],
  [/^packages\/resourceportal-web\/src\/pages\/app-group\/(?:create-app-wizard\.tsx|(?:application-navigation|layout|networking|route)(?:\.test)?\.tsx)$/, ["tenant-ux-patch"]],
  [/^scripts\/installer\/(target-upgrade|recovery)\.sh$/, ["upgrade-recovery", "platform-release", "installer"]],
  [/^scripts\/upgrade-recovery-from-0\.2\.78\.sh$/, ["upgrade-recovery", "platform-release", "installer"]],
  [/^test\/installer\/test-(target-upgrade|upgrade-preflight|upgrade-recovery)\.test\.mjs$/, ["upgrade-recovery"]],
  [/^packages\/resourceportal-web\/src\/App\.test\.tsx$/, ["reactive-web-state"]],
  [/^packages\/resourceportal-api\/src\/billing\/(?:billing-preflight\.guard(?:\.spec)?|billing-worker\.service|deployed-compute-allocation(?:\.spec)?)\.ts$/, ["billing-correctness"]],
  [/^packages\/resourceportal-api\/src\/disaster-recovery\/.*\.ts$/, ["recovery-safety"]],
  [/^packages\/resourceportal-api\/src\/internal\/(deployment-recovery\.service|stage6-worker-recovery\.spec)\.ts$/, ["recovery-safety", "registry-auth"]],
  [/^packages\/resourceportal-api\/src\/internal\/runtime-drift-reconciler\.pagination\.spec\.ts$/, ["recovery-safety"]],
  // Deployment placement labels drive SingleApp-to-Gate routing isolation.
  // Include the actual renderer assertion in targeted networking verification,
  // and retain release/rollback smoke for changes to this contract.
  [/^packages\/resourceportal-api\/src\/internal\/v020-placement-networking\.spec\.ts$/, ["networking", "platform-release"]],
  [/^packages\/resourceportal-api\/src\/internal\/(?:stack-rollout\.service(?:\.spec)?|deployment-mount-paths\.spec)\.ts$/, ["deployment-rollout"]],
  [/^packages\/resourceportal-api\/src\/internal\/stack-apply\.service(?:\.spec)?\.ts$/, ["deployment-rollout", "registry-auth"]],
  [/^packages\/resourceportal-api\/src\/internal\/stack-volume-provisioner\.service(?:\.spec)?\.ts$/, ["cross-node-storage"]],
  [/^packages\/resourceportal-api\/src\/storage-backends\/(?:nfs-remote-access-validator\.service(?:\.spec)?|shared-nfs-probe(?:\.spec)?|storage-backends\.service)\.ts$/, ["cross-node-storage"]],
  [/^packages\/resourceportal-api\/src\/operations\/executors\/volume-operation\.executors(?:\.spec)?\.ts$/, ["volume-operations"]],
  [/^packages\/resourceportal-api\/src\/volumes\/volume-usage-reconciler\.service(?:\.spec)?\.ts$/, ["volume-operations"]],
  [/^packages\/resourceportal-web\/src\/hooks\/use-api(?:\.test)?\.tsx?$/, ["reactive-web-state"]],
  [/^packages\/resourceportal-web\/src\/pages\/app-group\/app-edit(?:\.test)?\.tsx$/, ["reactive-web-state"]],
  [/^packages\/resourceportal-web\/src\/pages\/(?:billing-funding-ui\.test\.tsx|machine-credential-rotation\.test\.tsx|tenant-resources\.tsx)$/, ["reactive-web-state"]],
  [/^packages\/resourceportal-web\/src\/pages\/volume-operation-tracker(?:\.test)?\.ts$/, ["volume-operations"]],
  [/^packages\/resourceportal-api\/src\/storage-backends\/local-filesystem-storage-adapter\.service(\.spec)?\.ts$/, ["storage-isolation"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/volume-attachment-race\.spec\.ts$/, ["volume-safety"]],
  [/^packages\/resourceportal-api\/src\/internal\/isolated-docker-context(\.spec)?\.ts$/, ["registry-auth"]],
  [/^packages\/resourceportal-api\/src\/internal\/(stack-registry-auth\.service(\.spec)?|stack-apply\.service(\.spec)?|deployment-registry-isolation\.spec)\.ts$/, ["registry-auth"]],
  [/^packages\/resourceportal-api\/src\/volumes\/(volumes\.service\.ts|stage7-volume-lifecycle\.spec\.ts|deployed-volume-reference(\.spec)?\.ts)$/, ["volume-safety"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/app-groups\.service\.ts$/, ["applications", "volume-safety"]],
  [/^packages\/resourceportal-api\/src\/internal\/(deployment-domain-ownership\.spec|ingress-reconciler\.service(\.spec)?)\.ts$/, ["domains"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/(app-group-manifest(\.service)?(\.spec)?\.ts|cpu-quota-validation\.spec\.ts)$/, ["quota-security"]],
  [/^packages\/resourceportal-api\/src\/app-groups\/dto\/create-single-app\.dto\.ts$/, ["quota-security"]],
  [/^packages\/resourceportal-api\/src\/internal\/deployment-execution\.service\.ts$/, ["deployment-rollout", "quota-security", "registry-auth", "worker"]],
  [/^packages\/resourceportal-api\/src\/internal\/deployment-cpu-validation\.spec\.ts$/, ["quota-security", "registry-auth", "worker"]],
  [/^packages\/resourceportal-api\/src\/registries\/(registries\.service(\.spec)?\.ts|registry-ping(\.spec)?\.ts)$/, ["registry-validation"]],
  [/^packages\/resourceportal-api\/README\.md$/, []],
  [/^README\.md$/, ["workflow"]],
  [/^packages\/resourceportal-api\/scripts\/smoke-(deploy|stage11-quota-concurrency|stage15-capacity|stage16-operations|volume-lifecycle)\.ts$/, ["release-fixtures", "tenant-access", "platform-release"]],
  [/^packages\/resourceportal-api\/src\/config\/production-auth-entrypoints\.spec\.ts$/, ["release-fixtures", "identity"]],
  [/^packages\/resourceportal-web\/deployment-entrypoints\.test\.mjs$/, ["release-fixtures", "workflow"]],
  [/^scripts\/run-stage20-real-swarm-web-e2e\.mjs$/, ["release-fixtures", "platform-release"]],

  [/^config\/production\/release-manifest\.schema\.json$/, ["platform-release", "workflow"]],
  [/^scripts\/release-rollback-policy\.mjs$/, ["platform-release", "workflow"]],
  [/^scripts\/run-automatic-rollback-smoke\.sh$/, ["platform-release", "workflow"]],
  [/^scripts\/rollback-zitadel-runtime\.sh$/, ["platform-release", "workflow"]],
  [/^scripts\/publish-tested-release-image\.sh$/, ["platform-release", "workflow"]],
  [/^test\/installer\/test-gate-discovery-multilan\.py$/, ["networking", "platform-release"]],
  [/^test\/installer\/test-v020-placement-networking\.sh$/, ["installer", "platform-release", "networking"]],
  [/^test\/installer\/test-zitadel-management\.sh$/, ["installer", "platform-release", "identity"]],
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
  [/^packages\/resourceportal-api\/scripts\/setup-federation-e2e\.ts$/, ["identity", "security"]],
  [/^packages\/resourceportal-api\/scripts\/bootstrap-zitadel\.ts$/, ["identity", "security", "installer"]],
  [/^scripts\/run-federation-e2e\.sh$/, ["identity", "security"]],
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
  [/^scripts\/installer\/control-plane\.sh$/, ["platform-release", "installer", "networking"]],
  [/^scripts\/installer\/(config|identity|lifecycle|releases|smtp|upgrade)\.sh$/, ["platform-release", "installer"]],
  [/^scripts\/upgrade-recovery-from-0\.2\.68\.sh$/, ["platform-release", "installer"]],
  [/^test\/installer\/test-(releases|control-plane)\.sh$/, ["platform-release", "installer"]],
  [/^test\/installer\/test-swarm-required-capabilities\.sh$/, ["platform-release", "installer", "networking"]],
  [/^scripts\/installer\/(firewall|diagnostics)\.sh$/, ["installer", "networking"]],
  [/^test\/installer\/test-workflows\.sh$/, ["workflow"]],
  [/^test\/installer\/test-(host-runtime|diagnostics|core)\.sh$/, ["installer"]],

  [/^scripts\/run-(device-vpn|gate)-dataplane-smoke\.sh$/, ["networking", "workflow"]],
  [/^scripts\/run-app-lan-route-agent-smoke\.sh$/, ["networking", "workflow"]],
  [/^config\/production\/stack\.yml\.tpl$/, ["networking", "platform-release"]],
  [/^Dockerfile$/, ["platform-release"]],
  [/^\.github\/workflows\//, ["workflow"]],

  [/^scripts\/next-main-release\.mjs$/, ["platform-release", "workflow"]],
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
  if (output) appendFileSync(output, [
    `vpn_smoke=${plan.vpnSmoke}`,
    `federation_required=${plan.profiles.some((p) => ["identity", "mcp-oauth", "tenant-access", "security"].includes(p))}`,
    `installer_required=${plan.profiles.some((p) => ["installer", "platform-release", "runtime-config", "workflow"].includes(p))}`,
    "",
  ].join("\n"));
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