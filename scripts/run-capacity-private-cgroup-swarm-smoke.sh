#!/usr/bin/env bash
# Real Docker 29/systemd/cgroup-v2 regression for issue #384. Fail closed.
set -euo pipefail

engine_version="$(docker version --format '{{.Server.Version}}')"
engine_major="${engine_version%%.*}"
if ! [[ "$engine_major" =~ ^[0-9]+$ ]] || (( engine_major < 29 )); then
  echo "Capacity namespace E2E requires Docker Engine 29+ (found $engine_version)" >&2
  exit 1
fi
if [[ "$(docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}')" != "2 systemd" ]]; then
  echo 'Capacity namespace E2E requires cgroup v2 with the systemd driver' >&2
  exit 1
fi
if [[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != active ]]; then
  echo 'Capacity namespace E2E requires an active real Docker Swarm' >&2
  exit 1
fi

service="rp-capacity-cgroup-${GITHUB_RUN_ID:-local}-${BASHPID}"
app_id='11111111-2222-4333-8444-555555555555'
cleanup() {
  docker service rm "$service" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    if ! docker service inspect "$service" >/dev/null 2>&1; then break; fi
    sleep 1
  done
}
trap cleanup EXIT

# Exercise the migration boundary: a legacy workload initially has no
# container identity labels, even though it is a real running Swarm service.
docker service create --detach=true \
  --name "$service" --replicas 2 \
  alpine:3.20 sleep 300 >/dev/null

ready=0
for _ in $(seq 1 90); do
  replicas="$(docker service ls --filter "name=$service" --format '{{.Replicas}}')"
  if [[ "$replicas" == '2/2' ]]; then ready=2; break; fi
  sleep 1
done
if [[ "$ready" != 2 ]]; then
  docker service ps --no-trunc "$service" >&2 || true
  echo "Legacy Capacity E2E did not start two unlabeled replicas" >&2
  exit 1
fi
if docker service inspect "$service" --format '{{json .Spec.TaskTemplate.ContainerSpec.Labels}}' | grep -Fq 'resourceportal.single-app-id'; then
  echo 'Legacy Capacity E2E fixture unexpectedly already has task labels' >&2
  exit 1
fi

# The same Docker Engine optimistic-version API used by the controlled
# migration must preserve the full spec and add only the container task label.
engine_socket="${DOCKER_HOST:-$(docker context inspect --format '{{(index .Endpoints "docker").Host}}' "$(docker context show)")}"
case "$engine_socket" in
  unix://*) engine_socket="${engine_socket#unix://}" ;;
  *) echo 'Capacity migration E2E requires a local Unix socket' >&2; exit 1 ;;
esac
[[ -S "$engine_socket" ]] || { echo 'Capacity migration E2E has no Docker socket' >&2; exit 1; }
RP_CAPACITY_SERVICE="$service" RP_CAPACITY_LABEL="$app_id" RP_DOCKER_SOCKET="$engine_socket" node <<'NODE'
const http = require('node:http');
const assert = require('node:assert/strict');
const socketPath = process.env.RP_DOCKER_SOCKET;
async function call(method,path,body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve,reject) => {
    const request = http.request({ socketPath,method,path:`/v1.43${path}`,headers: payload ? {'content-type':'application/json','content-length':Buffer.byteLength(payload)} : {}},response=>{
      const chunks=[]; response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{ if(response.statusCode<200||response.statusCode>=300) return reject(Error(`Docker update HTTP ${response.statusCode}`)); const data=Buffer.concat(chunks).toString(); resolve(data?JSON.parse(data):null); });
      response.on('error',reject);
    });
    request.on('error',reject); request.end(payload);
  });
}
(async()=>{
  const live=await call('GET',`/services/${encodeURIComponent(process.env.RP_CAPACITY_SERVICE)}`);
  assert.ok(live.Version.Index>0);
  assert.ok(!live.Spec.TaskTemplate.ContainerSpec.Labels?.['resourceportal.single-app-id']);
  const preserved=JSON.stringify(live.Spec);
  live.Spec.TaskTemplate.ContainerSpec.Labels={...live.Spec.TaskTemplate.ContainerSpec.Labels,'resourceportal.single-app-id':process.env.RP_CAPACITY_LABEL};
  const changed=JSON.stringify(live.Spec);
  assert.notEqual(preserved,changed);
  await call('POST',`/services/${live.ID}/update?version=${live.Version.Index}`,live.Spec);
})().catch(e=>{console.error(e);process.exitCode=1});
NODE

ready=0
for _ in $(seq 1 90); do
  ready="$(docker ps --filter "label=resourceportal.single-app-id=$app_id" --format '{{.ID}}' | wc -l | tr -d ' ')"
  if [[ "$ready" == 2 ]]; then break; fi
  sleep 1
done
if [[ "$ready" != 2 ]]; then
  docker service ps --no-trunc "$service" >&2 || true
  echo "Capacity E2E did not start two Swarm replicas (got $ready)" >&2
  exit 1
fi

# The API candidate is built by the caller. Isolate PID/cgroup namespaces just
# like terminal-agent, while exposing only read-only host proc and cgroup mounts.
# A pinned Docker daemon may use an action-created socket, not /var/run/docker.sock.
if [[ ! -S "$engine_socket" ]]; then
  echo "Docker29 local daemon socket is missing" >&2
  exit 1
fi
docker run --rm -i --user 0:0 --cgroupns=private \
  --mount type=bind,source=/proc,target=/host/proc,readonly \
  --mount type=bind,source=/sys/fs/cgroup,target=/host/sys/fs/cgroup,readonly \
  --mount type=bind,source="$engine_socket",target=/var/run/docker.sock,readonly \
  --env NODE_ENV=test \
  --entrypoint node resourceportal-vpn-e2e:current - <<'NODE'
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { readFileSync, realpathSync } = require('node:fs');
const { startTerminalAgent } = require('./dist/src/terminal/terminal-agent.runner.js');
const { signedAgentHeaders } = require('./dist/src/terminal/terminal-agent-security.js');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 8000 }).trim();

async function run() {
  assert.equal(readFileSync('/proc/self/cgroup', 'utf8').trim(), '0::/',
    'probe process must be isolated in its private cgroup namespace');
  const ids = docker('ps', '--no-trunc', '--filter', 'label=resourceportal.single-app-id', '--format', '{{.ID}}')
    .split('\n').filter(Boolean);
  assert.equal(ids.length, 2, 'both Swarm replicas must be visible to the probe');
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{64}$/);
    const pid = Number(docker('inspect', '--format', '{{.State.Pid}}', id));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const membership = readFileSync(`/host/proc/${pid}/cgroup`, 'utf8');
    assert.ok(membership.split('\n').includes(`0::/../docker-${id}.scope`),
      'Docker 29 private namespace must expose the issue #384 sibling membership');
    const scope = `/host/sys/fs/cgroup/system.slice/docker-${id}.scope`;
    assert.equal(realpathSync(scope), scope, 'expected host systemd cgroup path');
  }
  const token = randomBytes(24).toString('hex');
  const server = startTerminalAgent(3102, token);
  try {
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const url = 'http://127.0.0.1:3102/internal/capacity-probe';
    const denied = await fetch(url, {method: 'POST', headers: {'x-internal-token': 'incorrect'}});
    assert.equal(denied.status, 403, 'capacity probe must reject unauthenticated requests');
    // The privileged node agent must not accept reusable bearer credentials.
    // Bind a single-use MAC to the exact read-only probe body, endpoint, and
    // destination address; prove that an identical replay is rejected.
    const body = '{}';
    const headers = signedAgentHeaders(token, '/internal/capacity-probe', body, '127.0.0.1');
    const response = await fetch(url, {method: 'POST', headers, body});
    assert.equal(response.status, 200);
    const report = await response.json();
    const replay = await fetch(url, {method: 'POST', headers, body});
    assert.equal(replay.status, 403, 'capacity probe must reject a replayed signature');
    assert.equal(report.status, 'Observed', JSON.stringify(report));
    assert.equal(report.containers.length, 2);
    assert.deepEqual(report.containers.map(c => c.id).sort(), ids.sort());
    for (const container of report.containers) {
      assert.match(container.memoryCurrentBytes, /^\d+$/);
      assert.match(container.memoryPeakBytes, /^\d+$/);
      assert.match(container.oomEvents, /^\d+$/);
    }
    console.log(`Docker 29 private-cgroup authenticated capacity E2E passed: ${ids.length} Swarm replicas observed`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
NODE
