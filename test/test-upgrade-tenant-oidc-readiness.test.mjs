import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const upgrade = readFileSync('scripts/installer/upgrade.sh', 'utf8');

function runProbe(responseCode, environment = 'production') {
  const shell = `
    set -euo pipefail
    source scripts/installer/upgrade.sh
    RP_CFG_ACME_ENVIRONMENT='${environment}'
    curl() {
      CURL_PROBE_ARGS="$*"
      return ${responseCode}
    }
    sleep() { :; }
    rp_upgrade_wait_for_tenant_oidc_ready portal.example.test 5
    printf 'curl:%s\\n' "$CURL_PROBE_ARGS"
  `;
  return spawnSync('bash', ['-c', shell], { encoding: 'utf8' });
}

test('upgrade checks tenant SSO readiness after migrations and deployment, before declaring success', () => {
  const migrate = upgrade.indexOf('rp_run_migrations ||');
  const readiness = upgrade.indexOf('rp_upgrade_wait_for_tenant_oidc_ready "${RP_CFG_DOMAIN:');
  const complete = upgrade.indexOf('rp_upgrade_checkpoint_phase completed');
  assert(migrate > 0 && readiness > migrate && complete > readiness);
  assert.match(upgrade, /rp_upgrade_restore_after_failure "\$manifest" "\$previous_stack" "tenant OIDC activation"/);
});

test('installer requires automatic rollback eligibility before mutating a live stack', () => {
  assert.match(upgrade, /rp_upgrade_preflight\(\)[\s\S]*?rp_upgrade_rollback_allowed "\$manifest"/);
  assert.match(upgrade, /rp_upgrade_apply\(\)[\s\S]*?rp_upgrade_rollback_allowed "\$manifest"[\s\S]*?rp_upgrade_checkpoint_prepare/);
});

test('installer accepts one-click readiness only after tenant OIDC health responds successfully', () => {
  const result = runProbe(0);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/portal\.example\.test\/api\/health\/tenant-oidc/);
  assert.match(result.stdout, /--resolve portal\.example\.test:443:127\.0\.0\.1/);
  assert.doesNotMatch(result.stdout, /--insecure/);
});

test('installer reports an unsafe tenant rollout as a failed upgrade', () => {
  const result = runProbe(22);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tenant OIDC activation did not become ready/);
});

test('staging TLS behavior matches standard installer origin check', () => {
  const result = runProbe(0, 'staging');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--insecure/);
});
