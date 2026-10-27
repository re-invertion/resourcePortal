#!/usr/bin/env bash
set -euo pipefail
# Real iproute2 in a fresh Linux tenant-style network namespace.
command -v ip >/dev/null
command -v nsenter >/dev/null
sudo -n true
ns="rp-lan-static-$$"
cleanup() { sudo -n ip netns delete "$ns" >/dev/null 2>&1 || true; }
trap cleanup EXIT
sudo -n ip netns add "$ns"
export RP_TEST_STATIC_NETNS="/var/run/netns/$ns"
npm exec --workspace @resource-portal/api -- vitest run src/networking/remote-lan-static-routing.nsenter.spec.ts


# Exercise the compiled production API matcher with Alpine iproute2 + util-linux
# inside the actual runtime image, not only the Ubuntu GitHub runner.
docker run --rm --privileged --network none --user root -i \
  --entrypoint node resourceportal-vpn-e2e:current - <<'NODE'
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {readRpStaticTable,inspectStaticRoutingClaim}=
  require('./dist/src/networking/remote-lan-static-routing.js');
const ip=(...args)=>spawnSync('nsenter',['--net=/proc/self/ns/net','--','ip',...args],
  {encoding:'utf8',timeout:12000});
const must=(...args)=>{
  const r=ip(...args);
  assert.equal(r.status,0,r.stderr||r.error?.message);
};
const routes=()=>readRpStaticTable(args=>ip(...args));
const claim={source:'192.168.100.132',gateway:'192.168.100.1',device:'rp-a-1234abcd',prefix:'192.168.100.0/24'};
const state=()=>inspectStaticRoutingClaim(claim,ip('-4','rule','show').stdout,routes());
const initial=ip('-4','route','show','table','20015');
assert.equal(initial.status,2);
assert.equal(initial.stdout,'');
assert.match(initial.stderr,/^Error: ipv4: FIB table does not exist\.\s*Dump terminated\.?\s*$/);
assert.equal(routes(),'');
assert.equal(state().fullyConfigured,false);
must('link','add',claim.device,'type','dummy');
must('link','set',claim.device,'up');
must('-4','addr','add',claim.source+'/24','dev',claim.device);
const addRoute=()=>{
  must('-4','route','add',claim.prefix,'dev',claim.device,'table','20015');
  must('-4','route','add','default','via',claim.gateway,'dev',claim.device,'table','20015');
};
const addRule=()=>must('-4','rule','add','pref','18015','from',claim.source+'/32','lookup','20015');
addRoute(); addRule();
assert.equal(state().fullyConfigured,true);
const same=ip('-4','route','get','192.168.100.3','from',claim.source);
assert.equal(same.status,0,same.stderr);
assert.match(same.stdout,/dev rp-a-1234abcd/);
assert.doesNotMatch(same.stdout,/via 192\.168\.100\.1/);
const other=ip('-4','route','get','8.8.8.8','from',claim.source);
assert.equal(other.status,0,other.stderr);
assert.match(other.stdout,/via 192\.168\.100\.1/);
must('-4','rule','del','pref','18015','from',claim.source+'/32','lookup','20015');
must('-4','route','del','default','via',claim.gateway,'dev',claim.device,'table','20015');
must('-4','route','del',claim.prefix,'dev',claim.device,'table','20015');
assert.equal(routes(),'');
addRoute(); addRule();
assert.equal(state().fullyConfigured,true);
console.log('PASS: Alpine runtime first Static attach, Static/DHCP/Static transitions');
NODE
