import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';

const registry=JSON.parse(readFileSync(new URL('../config/test-suites.json',import.meta.url)));
test('suite registry has unique ids, valid levels and existing workflows',()=>{
  const ids=registry.suites.map(s=>s.id);
  assert.equal(new Set(ids).size,ids.length);
  const levels=new Set(['unit','component','contract','integration','system','e2e','security','upgrade','packaging']);
  for(const suite of registry.suites){
    assert.ok(levels.has(suite.level),suite.id);
    assert.ok(Array.isArray(suite.command)&&suite.command.length>0,suite.id);
    assert.ok(['local','workflow'].includes(suite.environment),suite.id);
    if(suite.environment==='workflow'){
      assert.ok(suite.workflow,suite.id);
      assert.ok(existsSync(new URL('../.github/workflows/'+suite.workflow,import.meta.url)),suite.id);
    }
  }
});
test('real runtime suites retain explicit coverage',()=>{
  const ids=new Set(registry.suites.map(s=>s.id));
  for(const id of ['swarm','site-vpn','device-vpn','federation','installer','cli-package'])assert.ok(ids.has(id),id);
});
