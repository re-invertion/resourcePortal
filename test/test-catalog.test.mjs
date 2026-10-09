import test from 'node:test';
import assert from 'node:assert/strict';
import { domainFor, levelFor, validateBaseline, collectMatrix } from '../scripts/test-catalog.mjs';

test('test domain classification covers VPN, identity, MCP, security and installer',()=>{
  assert.equal(domainFor('packages/resourceportal-api/src/networking/device-vpn.spec.ts'),'networking');
  assert.equal(domainFor('packages/resourceportal-api/src/mcp/protocol.spec.ts'),'mcp');
  assert.equal(domainFor('packages/resourceportal-api/src/security/access.spec.ts'),'security');
  assert.equal(domainFor('test/installer/test-core.sh'),'installer');
});
test('test levels classify component, contract and unit consistently',()=>{
  assert.equal(levelFor('test/installer/test-core.sh'),'contract');
  assert.equal(levelFor('packages/resourceportal-web/src/pages/app-detail.test.tsx'),'component');
  assert.equal(levelFor('packages/resourceportal-api/src/mcp/auth.spec.ts'),'unit');
});
test('baseline fails closed for removed test files',()=>{
  assert.deepEqual(validateBaseline(['a.test.ts'],[]),{missing:['a.test.ts'],unknown:[],invalidMigrations:[]});
});
test('explicit migrations are accepted only when replacement file exists',()=>{
  const from='packages/resourceportal-api/src/auth/old.spec.ts';
  const to='packages/resourceportal-api/src/auth/new.spec.ts';
  assert.deepEqual(validateBaseline([from],[to],{[from]:to}),{missing:[],unknown:[],invalidMigrations:[]});
  assert.deepEqual(validateBaseline([from],[],{[from]:to}),{missing:[from],unknown:[],invalidMigrations:[from]});
});
test('domain-by-level matrix counts distinct test files',()=>{
  assert.deepEqual(collectMatrix(['test/installer/test-core.sh','test/installer/test-ui.sh']),{installer:{contract:2}});
});
