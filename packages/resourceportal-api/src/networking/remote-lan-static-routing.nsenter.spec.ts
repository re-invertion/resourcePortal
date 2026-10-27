import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {inspectStaticRoutingClaim,readRpStaticTable} from './remote-lan-static-routing';

const namespace=process.env.RP_TEST_STATIC_NETNS;
const active=namespace ? describe : describe.skip;
const device='rp-a-1234abcd';
const config={device,source:'192.168.100.132',gateway:'192.168.100.1',prefix:'192.168.100.0/24'};
function ip(...args:string[]) {
  return spawnSync('sudo',['-n','nsenter','--net='+namespace,'--','ip',...args],
    {encoding:'utf8',timeout:12000});
}
function routes(){return readRpStaticTable(args=>ip(...args));}
function rules(){const r=ip('-4','rule','show');expect(r.status).toBe(0);return r.stdout;}
active('real Linux iproute2/nsenter first Static attach and transitions',()=>{
  it('fails closed only until a trusted RP static source and route are provisioned',()=>{
    const fresh=ip('-4','route','show','table','20015');
    expect(fresh.status).toBe(2);
    expect(fresh.stdout).toBe('');
    expect(fresh.stderr).toMatch(/^Error: ipv4: FIB table does not exist\.\s*Dump terminated\.?\s*$/);
    expect(routes()).toBe('');
    expect(inspectStaticRoutingClaim(config,rules(),routes()).fullyConfigured).toBe(false);
    expect(ip('link','add',device,'type','dummy').status).toBe(0);
    expect(ip('link','set',device,'up').status).toBe(0);
    expect(ip('-4','addr','add','192.168.100.132/24','dev',device).status).toBe(0);
    expect(ip('-4','route','add',config.prefix,'dev',device,'table','20015').status).toBe(0);
    expect(ip('-4','route','add','default','via',config.gateway,'dev',device,'table','20015').status).toBe(0);
    expect(ip('-4','rule','add','pref','18015','from',config.source+'/32','lookup','20015').status).toBe(0);
    expect(inspectStaticRoutingClaim(config,rules(),routes()).fullyConfigured).toBe(true);
    const same=ip('-4','route','get','192.168.100.3','from',config.source);
    expect(same.status).toBe(0);
    expect(same.stdout).toContain('dev '+device);
    expect(same.stdout).not.toMatch(/\bvia\s+192\.168\.100\.1\b/);
    const other=ip('-4','route','get','8.8.8.8','from',config.source);
    expect(other.status).toBe(0);
    expect(other.stdout).toContain('via '+config.gateway);
    expect(other.stdout).toContain('dev '+device);

    // Static -> DHCP: revoke only the owned rule/route; table becomes absent again.
    expect(ip('-4','rule','del','pref','18015','from',config.source+'/32','lookup','20015').status).toBe(0);
    expect(ip('-4','route','del','default','via',config.gateway,'dev',device,'table','20015').status).toBe(0);
    expect(ip('-4','route','del',config.prefix,'dev',device,'table','20015').status).toBe(0);
    expect(inspectStaticRoutingClaim(config,rules(),routes()).fullyConfigured).toBe(false);
    // DHCP -> Static: the same missing-table error must remain safe to reconcile.
    expect(routes()).toBe('');
    expect(ip('-4','route','add',config.prefix,'dev',device,'table','20015').status).toBe(0);
    expect(ip('-4','route','add','default','via',config.gateway,'dev',device,'table','20015').status).toBe(0);
    expect(ip('-4','rule','add','pref','18015','from',config.source+'/32','lookup','20015').status).toBe(0);
    expect(inspectStaticRoutingClaim(config,rules(),routes()).fullyConfigured).toBe(true);
  });
});
