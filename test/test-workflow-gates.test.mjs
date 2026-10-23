import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import YAML from 'yaml';

const load=(name)=>YAML.parse(readFileSync(new URL('../.github/workflows/'+name,import.meta.url),'utf8'));

test('all RP GitHub workflow definitions parse as YAML with jobs',()=>{
  for(const name of ['ci.yml','fastfix.yml','release.yml','swarm-integration.yml','federation-integration.yml','production-installer.yml','tenant-oidc-live.yml']){
    const workflow=load(name);
    assert.ok(workflow.on,name);
    assert.ok(Object.keys(workflow.jobs).length>0,name);
  }
});
test('Fast Fix PR uses scoped validation while all main pushes run full CI',()=>{
  const fastfix=load('fastfix.yml'),ci=load('ci.yml');
  assert.ok(fastfix.on.push.branches.includes('main'));
  assert.match(fastfix.jobs['targeted-hotfix'].if,/github.event_name == 'push'/);
  assert.match(fastfix.jobs['targeted-hotfix'].if,/\[fastfix\]/);
  assert.match(ci.jobs.validate.if,/github.event_name != 'pull_request'/);
  assert.doesNotMatch(ci.jobs.validate.if,/\[fastfix\]/);
  assert.ok(ci.on.push.branches.includes('main'));
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
  assert.equal(release.concurrency['cancel-in-progress'],false);
  const classification=release.jobs.classify.steps.find(s=>s.name?.includes('Resolve next unused version'));
  assert.match(classification.run,/next-main-release\.mjs/);
  const publish=release.jobs.publish.steps.find(s=>s.name?.includes('Publish GitHub Release assets'));
  assert.match(publish.run,/--target "\$GITHUB_SHA"/);
  assert.doesNotMatch(publish.run,/--clobber/);
  assert.equal(release.permissions.actions,'read');
  const steps=release.jobs.publish.steps;
  const ciProof=steps.find(s=>s.name?.startsWith('Require successful post-merge full CI'));
  assert.ok(ciProof);
  assert.match(ciProof.run,/actions\/workflows\/ci\.yml\/runs/);
  assert.match(ciProof.run,/GITHUB_SHA/);
  assert.match(ciProof.run,/completed:success/);
  assert.match(ciProof.run,/completed:\*/);
  const patchFull=steps.find(s=>s.name?.startsWith('Recheck complete patch test'));
  assert.equal(patchFull.if,"steps.release-mode.outputs.mode == 'fastfix'");
  assert.match(patchFull.run,/npm run test/);
  assert.match(patchFull.run,/npm run test:installer/);
  assert.ok(steps.indexOf(ciProof) < steps.indexOf(patchFull));
  assert.ok(steps.indexOf(patchFull) < steps.findIndex(s=>s.name?.startsWith('Publish rollback-tested API image')));
  assert.ok(steps.indexOf(ciProof) < steps.indexOf(publish));
});
test('automatic rollback is mandatory before merge and any release artifacts',()=>{
  const readiness=load('release-readiness.yml');
  const release=load('release.yml');
  const prerelease=readiness.jobs.candidate.steps.find(s=>s.name?.startsWith('Require verified automatic rollback'));
  const publish=release.jobs.publish.steps;
  const prepublish=publish.find(s=>s.name?.startsWith('Require verified automatic rollback'));
  assert.ok(prerelease && prepublish);
  for(const step of [prerelease,prepublish]){
    assert.match(step.run,/release-rollback-policy\.mjs/);
    assert.match(step.run,/--require-automatic/);
  }
  const candidateSteps=readiness.jobs.candidate.steps;
  const premergeSmoke=candidateSteps.find(s=>s.name?.startsWith('Verify automatic rollback of published'));
  const prereleaseBuild=candidateSteps.find(s=>s.name?.startsWith('Build the three production'));
  const prepublishSmoke=publish.find(s=>s.name?.startsWith('Validate actual RP release images recover'));
  assert.ok(premergeSmoke && prereleaseBuild && prepublishSmoke);
  // Schema-changing releases need the *real* rollback smoke to produce
  // run-bound evidence before the rollback policy is allowed to certify them.
  assert.ok(candidateSteps.indexOf(prereleaseBuild) < candidateSteps.indexOf(premergeSmoke));
  assert.ok(candidateSteps.indexOf(premergeSmoke) < candidateSteps.indexOf(prerelease));
  assert.ok(publish.indexOf(prepublishSmoke) < publish.indexOf(prepublish));
  assert.ok(publish.indexOf(prepublish) < publish.findIndex(s=>s.name?.startsWith('Publish rollback-tested API image')));
  assert.match(prerelease.run,/--verified-evidence-file/);
  assert.match(prepublish.run,/--verified-evidence-file/);
  assert.match(premergeSmoke.env.RP_ROLLBACK_EVIDENCE_OUTPUT,/rp-rollback-evidence\.json/);
  // Each supported rollback source must produce fresh CI evidence; the
  // previous-source compatibility file is retained for older consumers.
  assert.match(prepublishSmoke.run,/RP_ROLLBACK_EVIDENCE_OUTPUT="\$source_file"/);
  assert.match(prepublishSmoke.run,/rollback-source-evidence/);
  assert.match(prepublishSmoke.run,/rp-rollback-evidence\.json/);
  assert.match(prepublishSmoke.run,/0\.2\.92/);
  assert.match(prepublishSmoke.run,/0\.2\.96/);
  assert.match(prepublishSmoke.run,/source_versions=\("\$\{PREVIOUS_TAG#v\}" "0\.2\.96" "0\.2\.93" "0\.2\.92"\)/);
  assert.match(prepublishSmoke.run,/--previous-tag "v\$source_version"/);
  assert.match(prepublishSmoke.run,/--verified-evidence-file "\$source_file"/);
  assert.match(prepublishSmoke.run,/--require-automatic/);
  assert.match(prepublishSmoke.run,/--arg source "0\.2\.96" --arg commit "\$GITHUB_SHA"/);
  assert.match(prepublishSmoke.run,/\.actualDatabaseMigration == true/);
  assert.match(prepublishSmoke.run,/\.previousImagesRestored == true/);
  assert.match(prepublishSmoke.run,/\.databaseSnapshotRestored == true/);
  assert.match(prepublishSmoke.run,/\.zitadelSourceRuntimeReadyAfterRollback == true/);
  assert.match(publish.find(s=>s.name?.startsWith('Create release manifest')).run,/rollbackCertifiedSources/);
  for (const smoke of [premergeSmoke,prepublishSmoke]){
    assert.match(smoke.run,/run-automatic-rollback-smoke\.sh/);
  }
  for(const image of ['api','web','postgres']){
    assert.match(prereleaseBuild.run,new RegExp('resourceportal-'+image+'-candidate'));
    assert.match(prepublishSmoke.run,new RegExp('resourceportal-'+image+'-candidate'));
  }

  const manifest=publish.find(s=>s.name?.startsWith('Create release manifest'));
  assert.match(manifest.run,/ROLLBACK_POLICY.*image-only/);
  assert.match(manifest.run,/ROLLBACK_POLICY.*tested/);
  assert.match(manifest.run,/rollbackEvidence/);
  assert.doesNotMatch(manifest.run,/image-only \|\|.*none/);
});

test('automatic rollback smoke uses official release digests and the production upgrade entry point',()=>{
  const source=readFileSync(new URL('../scripts/run-automatic-rollback-smoke.sh',import.meta.url),'utf8');
  assert.match(source,/resourceportal-release-manifest\.json/);
  assert.match(source,/gh attestation verify/);
  assert.match(source,/resourceportal-api-candidate/);
  assert.match(source,/resourceportal-web-candidate/);
  assert.match(source,/resourceportal-postgres-candidate/);
  assert.match(source,/rp_upgrade_apply/);
  assert.doesNotMatch(source,/^rp_upgrade_restore_after_failure\s*\(/m);
  assert.doesNotMatch(source,/^\s*if rp_upgrade_restore_after_failure/m);
  assert.match(source,/health_checks/);
  assert.match(source,/rolled-back/);
  assert.match(source,/service_images_match/);
});

test('Merge Queue requires full regression and applicable Fast Fix integration gates',()=>{
  const gate=load('release-readiness.yml');
  assert.ok('merge_group' in gate.on);
  assert.ok('pull_request' in gate.on);
  assert.deepEqual(gate.jobs['release-ready'].needs,['candidate','swarm','federation','installer','tenant-oidc']);
  const candidate=gate.jobs.candidate;
  assert.match(candidate.steps.find(s=>s.name?.startsWith('Validate all source')).if,/milestone/);
  const scoped=candidate.steps.find(s=>s.name?.startsWith('Validate affected patch'));
  assert.match(scoped.if,/fastfix/);
  assert.match(scoped.run,/fastfix-test-plan\.mjs.*--run/);
  const complete=candidate.steps.find(s=>s.name?.startsWith('Require complete regression suite'));
  assert.equal(complete.if,"steps.release-mode.outputs.mode == 'fastfix'");
  for(const command of ['npm run lint','npm run test','npm run build','npm run test:installer','npm run test:cli-release']){
    assert.ok(complete.run.includes(command),command);
  }
  assert.ok(candidate.steps.indexOf(complete) < candidate.steps.findIndex(s=>s.name?.startsWith('Build the three production')));
  assert.ok(gate.jobs['release-ready'].needs.includes('candidate'));
  assert.match(gate.jobs['release-ready'].steps[0].run,/verify_gate/);
  assert.match(gate.jobs['release-ready'].steps[0].run,/\$CANDIDATE.*success/);
  assert.equal(gate.jobs['tenant-oidc'].needs,'candidate');
  assert.match(gate.jobs['tenant-oidc'].uses,/tenant-oidc-live\.yml$/);
  assert.match(gate.jobs['tenant-oidc'].if,/federation_required/);
  assert.match(gate.jobs['release-ready'].steps[0].run,/verify_gate tenant-oidc/);
  const live=load('tenant-oidc-live.yml');
  assert.ok(live.on.workflow_call);
  assert.match(live.jobs['real-https-project-grants'].steps.find(s=>s.name?.includes('real pinned ZITADEL')).run,/run-tenant-oidc-https-e2e/);
  const conditionKeys={swarm:'vpn_smoke',federation:'federation_required',installer:'installer_required'};
  for(const name of ['swarm','federation','installer']){
    assert.equal(gate.jobs[name].with.force_gate,true);
    assert.equal(gate.jobs[name].needs,'candidate');
    assert.match(gate.jobs[name].if,new RegExp(conditionKeys[name]));
    assert.match(gate.jobs[name].if,/milestone/);
    const called=load(gate.jobs[name].uses.split('/').at(-1));
    assert.match(Object.values(called.jobs)[0].if,/inputs\.force_gate == true/);
  }
});


test('one-time unpublished main recovery for #318 remains SHA- and file-scoped', () => {
  const gate = load('release-readiness.yml');
  const guard = gate.jobs.candidate.steps.find((step) =>
    step.name?.startsWith('Block merges while the previous main release is unpublished'));
  assert.ok(guard);
  for (const exact of [
    'v0.2.97',
    'c98d22f68771c11e09843f4b87f0e25e65aee3df',
    '0f2918dd86cdbadedf2e5178e09bc7e9d2979956',
    'f2dfc5a72dc4ba981a6e2cb4b33d6d9a3ca9f86a',
    '.github/workflows/release-readiness.yml',
    'packages/resourceportal-api/src/billing/billing-voucher-codes.spec.ts',
    'test/test-workflow-gates.test.mjs',
  ]) assert.ok(guard.run.includes(exact), `missing exact recovery pin: ${exact}`);
  assert.match(guard.run, /git diff --name-only "\$main_sha" HEAD/);
  assert.match(guard.run, /recovery_diff.*allowed_diff/);
  assert.match(guard.run, /fixture_blob.*f2dfc5a72dc4ba981a6e2cb4b33d6d9a3ca9f86a/);
  assert.match(guard.run, /exit 1/);
  assert.match(guard.run, /node scripts\/next-main-release\.mjs --github-output/);
});
