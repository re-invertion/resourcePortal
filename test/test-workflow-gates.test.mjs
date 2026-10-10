import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';

const load=(name)=>YAML.parse(readFileSync(new URL('../.github/workflows/'+name,import.meta.url),'utf8'));

test('all RP GitHub workflow definitions parse as YAML with jobs',()=>{
  for(const name of ['ci.yml','fastfix.yml','release.yml','swarm-integration.yml','federation-integration.yml','production-installer.yml']){
    const workflow=load(name);
    assert.ok(workflow.on,name);
    assert.ok(Object.keys(workflow.jobs).length>0,name);
  }
});
test('fastfix main push uses scoped validator when normal CI skips [fastfix]',()=>{
  const fastfix=load('fastfix.yml'),ci=load('ci.yml');
  assert.ok(fastfix.on.push.branches.includes('main'));
  assert.match(fastfix.jobs['targeted-hotfix'].if,/github.event_name == 'push'/);
  assert.match(fastfix.jobs['targeted-hotfix'].if,/\[fastfix\]/);
  assert.match(ci.jobs.validate.if,/\[fastfix\]/);
});
test('milestone publishing must wait for Swarm, federation and installer gates',()=>{
  const release=load('release.yml');
  const jobs=['milestone-swarm','milestone-federation','milestone-installer'];
  for(const job of jobs){
    assert.ok(release.jobs[job].uses.endsWith('.yml'),job);
    assert.ok(release.jobs.publish.needs.includes(job),job);
    assert.match(release.jobs.publish.if,new RegExp('needs\\.'+job+'\\.result'));
    const called=load(release.jobs[job].uses.split('/').at(-1));
    assert.ok('workflow_call' in called.on,job);
  }
});
test('milestone release runs complete lint, test and build suite',()=>{
  const release=load('release.yml');
  const step=release.jobs.publish.steps.find(s=>s.name?.startsWith('Full lint'));
  assert.ok(step);
  assert.match(step.run,/npm run lint/);
  assert.match(step.run,/npm run test/);
  assert.match(step.run,/npm run build/);
});

test('called milestone gates cannot be suppressed by fastfix-tag commit messages',()=>{
  for(const name of ['swarm-integration.yml','federation-integration.yml','production-installer.yml']){
    const workflow=load(name);
    const job=Object.values(workflow.jobs)[0];
    assert.match(job.if,/startsWith\(github\.ref, 'refs\/tags\/v'\)/,name);
  }
});


test('main publication is automatic, serialized and never allows manual/tag release triggers',()=>{
  const release=load('release.yml');
  assert.ok(release.on.push.branches.includes('main'));
  assert.ok(!('workflow_dispatch' in release.on));
  assert.ok(!('tags' in release.on.push));
  assert.equal(release.concurrency.cancel-in-progress,false);
  const classification=release.jobs.classify.steps.find(s=>s.name?.includes('Resolve next version'));
  assert.match(classification.run,/next-main-release\.mjs/);
  const publish=release.jobs.publish.steps.find(s=>s.name?.includes('Publish GitHub Release assets'));
  assert.match(publish.run,/--target "\$GITHUB_SHA"/);
  assert.doesNotMatch(publish.run,/--clobber/);
});
test('Merge Queue cannot merge without release-ready candidate and all integration checks',()=>{
  const gate=load('release-readiness.yml');
  assert.ok('merge_group' in gate.on);
  assert.ok('pull_request' in gate.on);
  assert.deepEqual(gate.jobs['release-ready'].needs,['candidate','swarm','federation','installer']);
  assert.match(gate.jobs['release-ready'].steps[0].run,/!= success/);
  for(const name of ['swarm','federation','installer']){
    assert.equal(gate.jobs[name].with.force_gate,true);
    const called=load(gate.jobs[name].uses.split('/').at(-1));
    assert.match(Object.values(called.jobs)[0].if,/inputs\.force_gate == true/);
  }
});
