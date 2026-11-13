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
test('release delegates source and integration validation to pre-merge readiness and exact-SHA main CI',()=>{
  const release=load('release.yml'), readiness=load('release-readiness.yml');
  assert.equal(release.jobs.publish.needs,'classify');
  for(const name of ['milestone-swarm','milestone-federation','milestone-installer']){
    assert.equal(release.jobs[name],undefined,name);
  }
  for(const name of ['swarm-integration.yml','federation-integration.yml','production-installer.yml']){
    const gate=load(name);
    assert.ok('workflow_call' in gate.on);
    assert.ok('workflow_dispatch' in gate.on);
    assert.ok(!('push' in gate.on),name);
    assert.ok(!('pull_request' in gate.on),name);
  }
  for(const name of ['swarm','federation','installer']){
    assert.ok(readiness.jobs[name].uses.endsWith('.yml'),name);
    assert.equal(readiness.jobs[name].with.force_gate,true);
  }
});
test('review-triggered Release Readiness cannot cancel another required installer or Swarm gate on the same PR',()=>{
  const readiness=load('release-readiness.yml');
  assert.ok('pull_request_review' in readiness.on);
  assert.ok(readiness.on.pull_request_review.types.includes('submitted'));
  for(const [name,job] of [
    ['swarm-integration.yml','swarm'],
    ['production-installer.yml','installer'],
  ]){
    const called=load(name);
    assert.ok('workflow_call' in called.on,name);
    assert.equal(called.concurrency['cancel-in-progress'],false,name);
    assert.match(called.concurrency.group,/github\.run_id/,name);
    assert.match(called.concurrency.group,/github\.run_attempt/,name);
    // github.ref and github.sha are shared across multiple independent review
    // events, so neither one is sufficient for the concurrency group.
    assert.doesNotMatch(called.concurrency.group,/github\.ref|github\.sha/,name);
    assert.equal(readiness.jobs[job].with.force_gate,true,name);
    assert.ok(readiness.jobs['release-ready'].needs.includes(job),name);
  }
  // Never replace a failed/cancelled required job by success or skipped:
  // the release aggregator must continue to fail closed.
  const required=readiness.jobs['release-ready'].steps[0].run;
  assert.match(required,/verify_gate swarm "\$SWARM" true/);
  assert.match(required,/verify_gate installer "\$INSTALLER" true/);
  assert.match(required,/\$result" != success/);
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
  assert.equal(steps.find(s=>s.name?.startsWith('Recheck complete patch test')),undefined);
  assert.equal(steps.find(s=>s.name?.startsWith('Full lint')),undefined);
  assert.ok(steps.indexOf(ciProof) < steps.findIndex(s=>s.name?.startsWith('Validate actual RP release images recover')));
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
  const source146Smoke=candidateSteps.find(s=>s.name?.startsWith('Independently verify v0.2.146 RP and ZITADEL'));
  const source152Smoke=candidateSteps.find(s=>s.name?.startsWith('Independently verify v0.2.152 RP and ZITADEL'));
  const prereleaseBuild=candidateSteps.find(s=>s.name?.startsWith('Build the three production'));
  const prepublishSmoke=publish.find(s=>s.name?.startsWith('Validate actual RP release images recover'));
  assert.ok(premergeSmoke && source146Smoke && source152Smoke && prereleaseBuild && prepublishSmoke);
  // Schema-changing releases need the *real* rollback smoke to produce
  // run-bound evidence before the rollback policy is allowed to certify them.
  assert.ok(candidateSteps.indexOf(prereleaseBuild) < candidateSteps.indexOf(premergeSmoke));
  assert.ok(candidateSteps.indexOf(premergeSmoke) < candidateSteps.indexOf(source146Smoke));
  assert.ok(candidateSteps.indexOf(source146Smoke) < candidateSteps.indexOf(prerelease));
  assert.ok(candidateSteps.indexOf(source146Smoke) < candidateSteps.indexOf(source152Smoke));
  assert.ok(candidateSteps.indexOf(source152Smoke) < candidateSteps.indexOf(prerelease));
  assert.match(source152Smoke.run,/run-automatic-rollback-smoke\.sh "0\.2\.152"/);
  assert.match(source152Smoke.env.RP_ROLLBACK_EVIDENCE_OUTPUT,/rp-rollback-evidence-152\.json/);
  assert.match(source152Smoke.run,/--previous-tag v0\.2\.152 --head HEAD/);
  assert.match(source152Smoke.run,/--verified-evidence-file "\$RP_ROLLBACK_EVIDENCE_OUTPUT" --require-automatic/);
  assert.match(source152Smoke.run,/\.sourceVersion == "0\.2\.152" and \.targetCommit == \$commit/);
  assert.match(source152Smoke.run,/\.workflowRunId == \$run/);
  assert.match(source152Smoke.run,/\.zitadelDatabaseRestored == true/);
  assert.match(source152Smoke.run,/\.previousApiReadWriteAfterRollback == true/);
  assert.match(source152Smoke.run,/\.zitadelSourceEventstoreVerified == true/);
  const releaseSourceStep=publish.find(s=>s.name?.startsWith('Validate actual RP release images recover'));
  assert.match(releaseSourceStep.run,/source_versions=\("\$\{PREVIOUS_TAG#v\}" "0\.2\.152"/);
  assert.match(releaseSourceStep.run,/--arg source "0\.2\.152" --arg commit "\$GITHUB_SHA" --argjson run "\$GITHUB_RUN_ID"/);
  assert.match(source146Smoke.run,/run-automatic-rollback-smoke\.sh "0\.2\.146"/);
  assert.match(source146Smoke.env.RP_ROLLBACK_EVIDENCE_OUTPUT,/rp-rollback-evidence-146\.json/);
  assert.match(source146Smoke.run,/--previous-tag v0\.2\.146 --head HEAD/);
  assert.match(source146Smoke.run,/--verified-evidence-file "\$RP_ROLLBACK_EVIDENCE_OUTPUT" --require-automatic/);
  assert.match(source146Smoke.run,/\.sourceVersion == "0\.2\.146" and \.targetCommit == \$commit/);
  assert.match(source146Smoke.run,/\.workflowRunId == \$run/);
  assert.match(source146Smoke.run,/\.zitadelDatabaseRestored == true/);
  assert.match(source146Smoke.run,/\.previousApiReadWriteAfterRollback == true/);
  assert.match(source146Smoke.run,/\.zitadelSourceEventstoreVerified == true/);
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
  assert.match(prepublishSmoke.run,/source_versions=\("\$\{PREVIOUS_TAG#v\}" "0\.2\.152" "0\.2\.146" "0\.2\.96" "0\.2\.93" "0\.2\.92"\)/);
  // Last known-safe pre-incident source must pass a separate live two-DB
  // restore in the exact publishing run; v0.2.147 is not a safe intermediate.
  assert.match(prepublishSmoke.run,/--arg source "0\.2\.146" --arg commit "\$GITHUB_SHA" --argjson run "\$GITHUB_RUN_ID"/);
  assert.match(prepublishSmoke.run,/\.zitadelDatabaseRestored == true/);
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
  // New signed release manifests must carry the actual API callback contract
  // so an upgrade can compare immutable SOURCE and TARGET capabilities.
  assert.match(manifest.run,/apiCapabilities:\{appConsumerActionsV2Callback:true\}/);

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
  assert.deepEqual(gate.jobs['release-ready'].needs,['candidate','swarm','capacity-docker29','federation','installer','tenant-oidc']);
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
  const conditionKeys={swarm:'swarm_smoke',federation:'federation_required',installer:'installer_required'};
  for(const name of ['swarm','federation','installer']){
    assert.equal(gate.jobs[name].with.force_gate,true);
    assert.equal(gate.jobs[name].needs,'candidate');
    assert.match(gate.jobs[name].if,new RegExp(conditionKeys[name]));
    assert.match(gate.jobs[name].if,/milestone/);
    const called=load(gate.jobs[name].uses.split('/').at(-1));
    assert.match(Object.values(called.jobs)[0].if,/inputs\.force_gate == true/);
  }
});


test('unpublished #349 main admits only the immutable #356 security recovery through full gates', () => {
  const gate = load('release-readiness.yml');
  const guard = gate.jobs.candidate.steps.find((step) =>
    step.name?.startsWith('Block merges while the previous main release is unpublished'));
  assert.ok(guard);
  for (const exact of [
    'v0.2.118',
    'e3155f1cb3e77a28a513f9e6f305d2cd4f03c754',
    '52202280c92bb536080c5382e2de199dde93d21e',
    'package-lock.json:ddea2fe95c57b6bc5a747239831bd97228314fdb',
    'packages/resourceportal-api/package.json:b5dd485d7f87ed374351e820fc0a24cdcda7dd4f',
    'packages/resourceportal-web/package.json:500db66dc22b0ff97625e0c3b3c9def99842e686',
    'test/test-workflow-gates.test.mjs',
    '.github/workflows/release-readiness.yml',
  ]) assert.ok(guard.run.includes(exact), `security recovery must pin: ${exact}`);
  assert.match(guard.run, /git diff --name-only "\$main_sha" HEAD/);
  assert.match(guard.run, /recovery_diff.*allowed_diff/);
  assert.match(guard.run, /Security recovery dependency blob mismatch/);
  assert.match(guard.run, /exit 1/);
  const complete = gate.jobs.candidate.steps.find((step) =>
    step.name?.startsWith('Require complete regression suite'));
  assert.match(complete.run, /npm audit --audit-level=high/);
  for (const c of ['npm run lint', 'npm run test', 'npm run build', 'npm run test:installer', 'npm run test:cli-release']) {
    assert.ok(complete.run.includes(c), `security hotfix must keep full gate: ${c}`);
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


test("NVIDIA hardware acceptance is manual after a normally certified release", () => {
  const readiness=load("release-readiness.yml");
  const physical=load("nvidia-gpu-physical.yml");
  const gate=readiness.jobs["release-ready"];
  assert.ok(!readiness.jobs["gpu-physical"]);
  assert.ok(!gate.needs.includes("gpu-physical"));
  assert.match(gate.steps[0].run,/Release candidate validation failed/);
  assert.match(gate.steps[0].run,/verify_gate swarm/);
  assert.match(gate.steps[0].run,/verify_gate federation/);
  assert.match(gate.steps[0].run,/verify_gate installer/);
  assert.doesNotMatch(gate.steps[0].run,/physical-nvidia-swarm/);
  assert.ok(physical.on.workflow_dispatch.inputs.release_tag.required);
  const job=physical.jobs["gpu-physical"];
  assert.ok(job["runs-on"].includes("rp-isolated-nvidia-gpu"));
  assert.match(job.steps.find(step=>step.name==="Check official published release").run,/releases\/tags/);
  assert.match(job.steps.find(step=>step.name==="Run physical NVIDIA Swarm isolation").run,/scripts\/test-nvidia-gpu-swarm\.sh/);
  const mandatoryRollback=readiness.jobs.candidate.steps.find(step=>step.name?.startsWith("Require verified automatic rollback"));
  assert.match(mandatoryRollback.run,/--require-automatic/);
});

test("v0.2.130 interrupted main recovery is exact-source, tree-checked and does not bypass full gates", () => {
  const gate = load("release-readiness.yml");
  const step = gate.jobs.candidate.steps.find((x) =>
    x.name?.startsWith("Block merges while the previous main release is unpublished"));
  for (const value of [
    "v0.2.128",
    "34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0",
    "0ae0827bfc2a0971a4ffd37becbe0e61438b32e7",
    "node scripts/release-backlog-recovery.mjs",
    "node scripts/audit-v02129-release-recovery.mjs",
    'gh release view "v0.2.130"',
    'node scripts/next-main-release.mjs --github-output',
  ]) assert.ok(step.run.includes(value), "recovery guard missing: " + value);
  assert.doesNotMatch(step.run, /continue-on-error|force-push|--force|workflow_dispatch/);
  const classifier = readFileSync(new URL("../scripts/next-main-release.mjs", import.meta.url), "utf8");
  assert.match(classifier, /verifyBacklogCheckout/);
  assert.match(classifier, /publishedCommit === BACKLOG\.publishedSha/);
  assert.match(classifier, /target !== BACKLOG\.blockedMainSha/);
  assert.match(classifier, /releaseMode\(recoveryTag/);
  const recovery = readFileSync(new URL("../scripts/release-backlog-recovery.mjs", import.meta.url), "utf8");
  assert.match(recovery, /v0\.2\.129/);
  assert.match(recovery, /v0\.2\.130/);
  assert.match(recovery, /"scripts\/publish-tested-release-image\.sh": "db77813/);
  assert.match(recovery, /"scripts\/audit-v02129-release-recovery\.mjs": "6b8ba66521d/);
  for (const command of [
    "npm audit --audit-level=high", "npm run lint", "npm run test",
    "npm run build", "npm run test:installer", "npm run test:cli-release",
  ]) assert.ok(gate.jobs.candidate.steps.some((x) => x.run?.includes(command)),
    "full gate absent: " + command);
  assert.ok(gate.jobs.candidate.steps.some((x) => /rollback/i.test(x.name)));
});


test("v0.2.131 recovery preserves protected gates and pins the failed main, GHCR and Docker identity fix", () => {
  const readiness = load("release-readiness.yml");
  const step = readiness.jobs.candidate.steps.find(x => x.name?.startsWith("Block merges while the previous main release is unpublished"));
  assert.ok(step);
  for (const val of [
    "v0.2.128", "34bbb1a0b918fb46b71c988fe79c22ee6bf7cca0",
    "98f9e94b2b4bcf55cbf791dc38be4a4a6028cb26",
    "node scripts/release-backlog-131.mjs", "node scripts/audit-v02130-release-recovery.mjs",
    'gh release view "v0.2.131"', "node scripts/next-main-release.mjs --github-output",
  ]) assert.ok(step.run.includes(val), "missing recovery proof " + val);
  const allocator = readFileSync(new URL("../scripts/next-main-release.mjs", import.meta.url), "utf8");
  assert.match(allocator, /verify131Checkout/);
  assert.match(allocator, /publishedCommit === BACKLOG_131\.publishedSha/);
  assert.match(allocator, /target !== BACKLOG_131\.blockedMainSha/);
  const source = readFileSync(new URL("../scripts/release-backlog-131.mjs", import.meta.url), "utf8");
  assert.match(source, /"scripts\/publish-tested-release-image\.sh": "874c352/);
  assert.match(source, /"scripts\/audit-v02130-release-recovery\.mjs": "1a74d77/);
  for (const name of ["Require complete regression suite for every Fast Fix before merge", "Require verified automatic rollback"]) {
    assert.ok(readiness.jobs.candidate.steps.some(x => x.name?.startsWith(name)), name);
  }
  assert.doesNotMatch(step.run, /continue-on-error|force-push|workflow_dispatch/);
});


test('Docker 29 private cgroup capacity must pass real Swarm before any merge (#384)',()=>{
  const readiness=load('release-readiness.yml');
  const gate=readiness.jobs['capacity-docker29'];
  assert.ok(gate, 'Docker 29 capacity job missing');
  assert.match(gate.if,/capacity_smoke/);
  const setup=gate.steps.find(s=>s.name?.includes('Docker Engine 29'));
  assert.ok(setup);
  assert.equal(setup.with.version,'v29.8.0');
  assert.equal(setup.with['set-host'],true);
  assert.ok(gate.steps.some(s=>s.run?.includes('scripts/run-capacity-private-cgroup-swarm-smoke.sh')));
  const required=readiness.jobs['release-ready'];
  assert.ok(required.needs.includes('capacity-docker29'));
  const check=required.steps[0];
  assert.match(check.run,/verify_gate capacity-docker29 "\$CAPACITY" true/);
  assert.ok(check.env.CAPACITY_SMOKE);
  assert.ok(check.env.CAPACITY);
  const stockSwarm=load('swarm-integration.yml');
  assert.ok(!stockSwarm.jobs['real-swarm'].steps.some(s=>s.run?.includes('scripts/run-capacity-private-cgroup-swarm-smoke.sh')),
    'Docker 29 regression must run on pinned daemon, not arbitrary stock runner');
});

test('signed App Consumer callback capability matches the built production API and remains tested', () => {
  // A future release must not advertise this signed compatibility claim after
  // accidentally dropping the corresponding API module, route, raw-body
  // verifier or executable contract tests.
  const read = (path) => readFileSync(new URL('../'+path, import.meta.url), 'utf8');
  assert.match(read('packages/resourceportal-api/src/api.module.ts'), /AppConsumersModule/);
  assert.match(read('packages/resourceportal-api/src/app-consumers/app-consumers.module.ts'),
    /AppConsumerActionController/);
  assert.match(read('packages/resourceportal-api/src/app-consumers/app-consumer-action.controller.ts'),
    /@Controller\("app-consumer-actions"\)/);
  assert.match(read('packages/resourceportal-api/src/app-consumers/app-consumer-action.controller.ts'),
    /@Post\("preaccesstoken"\)/);
  assert.match(read('packages/resourceportal-api/src/app-consumers/app-consumer-action.service.ts'),
    /verifyActionSignature/);
  assert.match(read('packages/resourceportal-api/src/config/secret-file-loader.ts'),
    /RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY/);
  assert.match(read('package.json'), /test-app-consumer-actions\.sh/);
});

test('Required release readiness blocks Draft, stale Codex review and all unresolved threads on PR and merge_group',()=>{
  const readiness=load('release-readiness.yml');
  assert.ok(readiness.on.merge_group !== undefined);
  assert.ok(readiness.on.pull_request.types.includes('ready_for_review'));
  assert.ok(readiness.on.pull_request.types.includes('converted_to_draft'));
  assert.deepEqual(readiness.on.pull_request_review.types,['submitted','edited','dismissed']);
  assert.match(readiness.jobs.candidate.if,/merge_group/);
  assert.match(readiness.jobs.candidate.if,/pull_request[.]draft == false/);
  assert.equal(readiness.jobs['release-ready'].if,'always()');

  // Only GitHub Actions status-check-eligible review events are a valid
  // automatic recheck path; issue_comment checks cannot satisfy main rules.
  assert.equal(readiness.on.issue_comment,undefined);
  assert.equal(readiness.on.pull_request_review_comment,undefined);
  assert.equal(readiness.permissions.issues,'read');
  const job=readiness.jobs['release-ready'];
  const review=job.steps.find(s=>s.name?.startsWith('Reject Draft and unresolved Codex'));
  assert.ok(review,'Missing required review gate');
  assert.match(review.run,/release-review-gate\.mjs/);
  const gates=job.steps.findIndex(s=>s.name?.startsWith('Fail closed unless'));
  assert.ok(job.steps.indexOf(review) > gates,'Review guard must run before required job can succeed');
  assert.ok(job.steps.some(s=>s.uses?.startsWith('actions/checkout@')),'Review script must be checked out');
});

test("trusted Codex comment update only reruns the existing failed required PR check", () => {
  const retry=load("codex-review-recheck.yml");
  assert.deepEqual(retry.on.issue_comment.types, ["created","edited"]);
  assert.ok(retry.on.schedule.length);
  assert.equal(retry.permissions.actions,"write");
  assert.equal(retry.permissions["pull-requests"],"read");
  assert.equal(retry.permissions.issues,"read");
  assert.ok(!retry.on.workflow_dispatch);
  const job=retry.jobs.recheck;
  assert.match(job.if,/chatgpt-codex-connector/);
  assert.match(job.if,/codex-review-state:v1/);
  const script=job.steps.find(s=>s.run?.includes("release-review-recheck.mjs"));
  assert.ok(script);
  assert.ok(script.env.GITHUB_TOKEN);
  const source=readFileSync(new URL("../scripts/release-review-recheck.mjs",import.meta.url),"utf8");
  assert.match(source,/rerun-failed-jobs/);
  assert.match(source,/isEligibleFailedRun/);
  assert.match(source,/shouldRerunReview/);
  assert.doesNotMatch(source,/createCheckRun|createCommitStatus|\/statuses\//);
});

test('independent network dataplane is selected only for networking and milestones, without bypassing Swarm gate',()=>{
  const main=load('release-readiness.yml');
  const called=load('swarm-integration.yml');
  assert.equal(called.on.workflow_call.inputs.vpn_required.type,'boolean');
  assert.equal(called.on.workflow_call.inputs.vpn_required.default,false);
  assert.match(main.jobs.swarm.with.vpn_required,/vpn_smoke/);
  assert.match(main.jobs.swarm.with.vpn_required,/milestone/);
  assert.match(called.jobs['real-swarm'].if,/force_gate/);
  assert.match(called.jobs['network-dataplane'].if,/inputs\.vpn_required == true/);
  const app=called.jobs['real-swarm'].steps.map(s=>s.run||'').join('\n');
  const net=called.jobs['network-dataplane'].steps.map(s=>s.run||'').join('\n');
  assert.match(app,/run-real-swarm-smoke\.sh/);
  assert.doesNotMatch(app,/run-remote-lan-l2-dhcp-smoke\.sh|run-device-vpn-dataplane-smoke\.sh/);
  for(const name of ['run-remote-lan-l2-dhcp-smoke.sh','run-device-vpn-dataplane-smoke.sh',
    'run-remote-lan-gateway-sysctl-swarm-smoke.sh','run-remote-lan-static-nsenter-smoke.sh']){
    assert.ok(net.includes(name),name);
  }
  assert.match(net,/RP_LAN_REAL_CONTROL_PLANE_FAULT/);
  assert.match(net,/api:start/);
  assert.match(net,/docker swarm init/);
  assert.match(net,/npm run build --workspace @resource-portal\/help/);
  assert.match(net,/docker network create --driver overlay resourceportal-smoke-control-plane/);
  assert.match(main.jobs['release-ready'].steps[0].run,/verify_gate swarm "\$SWARM" true/);
  for(const wf of [called,load('tenant-oidc-live.yml'),load('federation-integration.yml')]){
    assert.ok(Object.values(wf.jobs).some(j=>j.steps.some(s=>s.uses==='actions/cache@v4' &&
      String(s.with?.key).includes('hashFiles'))),'missing version-bound browser cache');
  }
  const report=main.jobs['release-ready'].steps.find(s=>s.name?.startsWith('Report slowest'));
  assert.equal(report.if,'always()');
  assert.equal(report['continue-on-error'],true);
  assert.match(report.run,/actions\/runs\/\$GITHUB_RUN_ID\/jobs/);
});
