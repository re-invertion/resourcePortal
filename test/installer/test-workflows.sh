#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
contains_file(){ local file="$1" needle="$2" name="$3"; grep -Fq -- "$needle" "$file" && pass "$name" || fail "$name"; }

check_workflow(){
  local file="$1" expected_name="$2" label="$3"
  [[ -f "$file" ]] && pass "$label workflow exists" || { fail "$label workflow exists"; return; }
  contains_file "$file" "name: $expected_name" "$label workflow has clear name"
  contains_file "$file" 'npm run test:installer' "$label workflow gates on Production Installer tests"
}

check_workflow "$repo_root/.github/workflows/ci.yml" 'ResourcePortal CI + Installer' 'CI'
check_workflow "$repo_root/.github/workflows/swarm-integration.yml" 'Installer + Real Docker Swarm' 'Swarm'
check_workflow "$repo_root/.github/workflows/federation-integration.yml" 'Installer + Identity Federation' 'Federation'
check_workflow "$repo_root/.github/workflows/codespaces-preview.yml" 'Installer + Codespaces Preview' 'Codespaces'
check_workflow "$repo_root/.github/workflows/release.yml" 'Installer-Gated Release' 'Release'
check_workflow "$repo_root/.github/workflows/stage20-dev.yml" 'Installer + Web Console Dev' 'Web dev'
check_workflow "$repo_root/.github/workflows/production-installer.yml" 'Production Installer Quality Gate' 'Dedicated installer'

contains_file "$repo_root/.github/workflows/production-installer.yml" 'shellcheck --severity=warning' 'dedicated installer gate runs ShellCheck'
contains_file "$repo_root/.github/workflows/production-installer.yml" 'test/installer/test-acme-resilience.sh' 'dedicated installer gate highlights ACME resilience suite'
contains_file "$repo_root/.github/workflows/codespaces-preview.yml" 'scripts/installer/**' 'Codespaces workflow watches installer changes'
contains_file "$repo_root/.github/workflows/codespaces-preview.yml" 'test/installer/**' 'Codespaces workflow watches installer tests'
contains_file "$repo_root/.github/workflows/ci.yml" 'npm run test:cli-release' 'CI validates installable CLI release package'
contains_file "$repo_root/.github/workflows/federation-integration.yml" 'run: npx playwright install --with-deps chromium' 'Federation uses Playwright from npm ci dependency graph'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'run: npx playwright install --with-deps chromium' 'Swarm smoke uses Playwright from npm ci dependency graph'
if grep -Fq -- 'npm install --no-save --package-lock=false playwright' "$repo_root/.github/workflows/federation-integration.yml" "$repo_root/.github/workflows/swarm-integration.yml"; then fail 'CI workflows avoid ad-hoc Playwright npm install'; else pass 'CI workflows avoid ad-hoc Playwright npm install'; fi
for smoke in scripts/run-stage20-real-swarm-web-e2e.mjs scripts/verify-stage20-management-matrix.mjs; do contains_file "$repo_root/$smoke" 'process.env.RESOURCE_PORTAL_API_URL' "$smoke uses the dedicated test API origin"; contains_file "$repo_root/$smoke" 'await route.fetch({' "$smoke bridges browser API calls directly to the test API"; done
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" 'runOperationToTerminal' 'real-Swarm browser smoke drains the v0.2 Operation queue to a specific terminal operation'
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" 'RolledBack' 'real-Swarm browser smoke validates rollback terminal semantics'
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" 'STAGE20_WORKER_TIMEOUT_MS' 'real-Swarm browser smoke bounds one-shot worker execution'
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" 'process.stdout.write(text);' 'real-Swarm browser smoke streams worker stdout while it runs'
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" 'process.kill(-child.pid, signal);' 'real-Swarm browser smoke terminates the whole worker process group on timeout'
contains_file "$repo_root/scripts/run-stage20-real-swarm-web-e2e.mjs" '[stage20]' 'real-Swarm browser smoke emits progress markers'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'timeout-minutes: 10' 'Swarm browser smoke has a bounded step timeout'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" '--label-add rp.node.tenant-workloads=true' 'real-Swarm runner is eligible for tenant workload placement'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" '--label-add rp.node.ingress=true' 'real-Swarm runner is eligible for ingress placement'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'TRAEFIK_SERVICE_NAME: resourceportal-smoke-traefik-anchor' 'real-Swarm smoke configures an explicit ingress anchor service'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'docker network create' 'real-Swarm smoke creates an ingress anchor base network'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'resourceportal-smoke-control-plane' 'real-Swarm smoke names its ingress anchor base network'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" '--name "$TRAEFIK_SERVICE_NAME"' 'real-Swarm smoke creates its ingress anchor service'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" '--network resourceportal-smoke-control-plane' 'real-Swarm ingress anchor stays on a base network'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'docker service rm "$TRAEFIK_SERVICE_NAME" || true' 'real-Swarm smoke removes its ingress anchor service'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'docker network rm resourceportal-smoke-control-plane || true' 'real-Swarm smoke removes its ingress anchor base network'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'docker pull nginx:alpine' 'Swarm browser smoke pre-pulls its workload image'
contains_file "$repo_root/.github/workflows/swarm-integration.yml" 'bash scripts/run-v022-privileged-networking-smoke.sh' 'real-Swarm workflow validates v0.2.2 privileged internal port enforcement'
contains_file "$repo_root/scripts/run-v022-privileged-networking-smoke.sh" 'RP-TENANT-INTERNAL-PORTS' 'v0.2.2 smoke validates the internal-port firewall chain'
contains_file "$repo_root/scripts/run-v022-privileged-networking-smoke.sh" 'Denied external network namespace unexpectedly reached' 'v0.2.2 smoke verifies untrusted clients are rejected'
contains_file "$repo_root/.github/workflows/release.yml" 'run: npm ci' 'Release installs Node dependencies before CLI build'
contains_file "$repo_root/.github/workflows/release.yml" 'npm run build --workspace @resource-portal/sdk' 'Release builds SDK for CLI package'
contains_file "$repo_root/.github/workflows/release.yml" 'npm run build --workspace @resource-portal/cli' 'Release builds CLI package'
contains_file "$repo_root/.github/workflows/release.yml" 'scripts/package-cli-release.sh' 'Release packages installable CLI asset'
contains_file "$repo_root/.github/workflows/release.yml" 'cli-release/SHA256SUMS' 'Release publishes CLI checksums'
contains_file "$repo_root/.github/workflows/release.yml" 'cli-release/resource-portal-cli-${VERSION}.tgz' 'Release publishes versioned CLI archive'
contains_file "$repo_root/.github/workflows/release.yml" '"./cli-release/resource-portal-cli-${VERSION}.tgz"' 'Release verifies CLI from an explicit local tarball path'

if (( failures > 0 )); then printf '%s workflow test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer workflow contract tests passed.\n'
