import {describe,expect,it} from "vitest";
import {gateLanBridgeName,gateLanBridgePlan,gateLanBridgeCleanup,type GateLanBridge} from "./remote-lan-gate-bridge";
import {observeManagedUplink} from "./remote-lan-managed-uplink";
const input:GateLanBridge={
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  lanDevice:"eth1",
  tunnel:{
    gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
    tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
    serverTunnelAddress:"100.96.0.1/30",
    clientTunnelAddress:"100.96.0.2/30",
    side:"gate",interface:"rp-gate",
  },
};
const links=[{ifname:"eth1",ifindex:2,link_type:"ether",operstate:"UP"}];
const addresses=[{ifname:"eth1",addr_info:[]}];
const routes=[{dst:"default",dev:"eth0"}];
describe("isolated Gate LAN bridge",()=>{
  it("bridges only an unnumbered dedicated port and a Gate tunnel",()=>{
    const cmd=gateLanBridgePlan(input,links,addresses,routes);
    expect(cmd[0][1]).toContain("bridge");
    expect(cmd.some(x=>x[1].includes("eth1")&&x[1].includes("master"))).toBe(true);
    expect(JSON.stringify(cmd)).not.toContain("eth0");
    expect(JSON.stringify(cmd)).toContain("isolated");
    expect(JSON.stringify(cmd)).toContain("vlan_filtering");
  });
  it("rejects management Ethernet with IP or default route",()=>{
    expect(()=>gateLanBridgePlan(input,links,
      [{ifname:"eth1",addr_info:[{family:"inet",local:"192.168.1.2"}]}],routes)).toThrow();
    expect(()=>gateLanBridgePlan(input,links,addresses,[{dst:"default",dev:"eth1"}])).toThrow();
  });
  it("reuses exclusively owner-tagged bridge and refuses impostors",()=>{
    const name=gateLanBridgeName(input.gateId,input.lanDevice);
    const existing=[{...links[0],master:name},{ifname:name,ifindex:6,
      ifalias:"rp-lan:"+input.gateId+":eth1",linkinfo:{info_kind:"bridge"}}];
    const commands=gateLanBridgePlan(input,existing,addresses,routes);
    expect(commands.some(x=>x[1].includes("eth1")&&x[1].includes("master"))).toBe(false);
    expect(()=>gateLanBridgePlan(input,[existing[0],{...existing[1],ifalias:"other"}],addresses,routes)).toThrow();
  });
  it("keeps the separately managed bridge after last application removal",()=>{
    const name=gateLanBridgeName(input.gateId,"eth0");
    const at=new Date().toISOString();
    const l=[{ifname:"eth0",ifindex:2,link_type:"ether",operstate:"UP",master:name},
      {ifname:name,ifindex:6,operstate:"UP",link_type:"ether",linkinfo:{info_kind:"bridge"},
      ifalias:"rp-lan:"+input.gateId+":eth0"}];
    const addr=[{ifname:"eth0",addr_info:[]},
      {ifname:name,addr_info:[{family:"inet",local:"192.168.100.11",prefixlen:24}]}];
    const route=[{dst:"default",dev:name,gateway:"192.168.100.1"}];
    const observation=observeManagedUplink({gateId:input.gateId,device:"eth0",links:l,
      addresses:addr,routes:route,manager:"systemd-networkd",networkManagerOwnsDevice:true,
      checkpointVerified:true,watchdogArmed:true,rollbackTested:true,
      controlPlaneReachable:true,agentVersion:"gate-l2-v2",observedAt:at});
    const managed:GateLanBridge={...input,lanDevice:"eth0",uplinkMode:"ManagedSharedUplink",
      managedObservation:observation};
    expect(gateLanBridgePlan(managed,l,addr,route).some(x=>
      x[1].includes("eth0")&&x[1].includes("master"))).toBe(false);
    const cleanup=gateLanBridgeCleanup(managed,l,0);
    expect(cleanup).toHaveLength(1);
    // Revocation must work with stale/missing observations after failures.
    expect(gateLanBridgeCleanup({...managed,managedObservation:undefined},l,0)).toHaveLength(1);
    expect(JSON.stringify(cleanup)).not.toContain("nomaster");
    expect(JSON.stringify(cleanup)).not.toContain("bridge");
    expect(()=>gateLanBridgePlan({...managed,managedObservation:undefined},l,addr,route))
      .toThrow(/Ready observation/);
    expect(()=>gateLanBridgePlan(managed,links,addresses,routes))
      .toThrow(/independently/);
  });
  it("tears down only RP-owned tunnels and never removes other bridge members",()=>{
    const name=gateLanBridgeName(input.gateId,input.lanDevice);
    const bridge={ifname:name,ifindex:6,ifalias:"rp-lan:"+input.gateId+":eth1",
      linkinfo:{info_kind:"bridge"}};
    const existing=[{...links[0],master:name},bridge];
    const cleanup=gateLanBridgeCleanup(input,existing,0);
    expect(cleanup.map(x=>x[1][0])).toEqual(["link","link","link"]);
    expect(JSON.stringify(cleanup)).toContain("nomaster");
    expect(()=>gateLanBridgeCleanup(input,[...existing,{ifname:"rogue",master:name}],0)).toThrow();
    expect(gateLanBridgeCleanup(input,existing,1)).toHaveLength(1);
  });
});
