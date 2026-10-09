import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionPlan} from '../scripts/test-selection.mjs';

test('domain selection groups tests into workspace runner and keeps deterministic path ordering',()=>{
  const plan=selectionPlan([
    'packages/resourceportal-api/src/networking/b.spec.ts',
    'packages/resourceportal-api/src/networking/a.spec.ts',
    'packages/resourceportal-web/src/pages/device-vpn-panel.test.tsx'
  ],{domain:'networking'});
  assert.equal(plan.paths.length,2);
  assert.deepEqual(plan.commands,[['npm','--workspace','@resource-portal/api','test','--',
    'src/networking/b.spec.ts','src/networking/a.spec.ts']]);
});
test('shell installer contract tests execute through bash without a workspace',()=>{
  const plan=selectionPlan(['test/installer/test-core.sh'],{domain:'installer',level:'contract'});
  assert.deepEqual(plan.commands,[['bash','test/installer/test-core.sh']]);
});
test('not matched test paths never start a runner',()=>{
  assert.deepEqual(selectionPlan(['packages/resourceportal-api/src/security/auth.spec.ts'],{domain:'networking'}),{paths:[],commands:[]});
});
