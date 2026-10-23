import {describe,expect,it} from "vitest";
import {gateLanBridgeName,gateLanBridgePlan,gateLanBridgeCleanup,type GateLanBridge} from "./remote-lan-gate-bridge";
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
