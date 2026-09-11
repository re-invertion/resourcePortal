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

if (( failures > 0 )); then printf '%s workflow test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer workflow contract tests passed.\n'
