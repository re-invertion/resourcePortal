import {describe,expect,it} from "vitest";
import {gatewayL2SetupPlan,gatewayL2CleanupPlan,type GatewayL2Input} from "./remote-lan-gateway-plan";
const input:GatewayL2Input={
  app:{
    side:"gateway",
    attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
    tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
    appOverlayIp:"10.200.6.12",
    gatewayOverlayIp:"10.200.6.20",
    overlayCidr:"10.200.6.0/24",
    overlayInterface:"eth1",
    macAddress:"02:aa:bb:cc:dd:ee",
  },
  wireguard:{
    side:"resourceportal",
    attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
    tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
    serverTunnelAddress:"100.96.0.1/30",
    clientTunnelAddress:"100.96.0.2/30",
    interface:"wg0",
  },
};
describe("RP Gateway app-to-customer L2 bridge",()=>{
  it("installs app MAC firewall before either encrypted tunnel enters bridge",()=>{
    const cmd=gatewayL2SetupPlan(input);
    const firstMaster=cmd.findIndex(x=>x[1].includes("master"));
    const rules=cmd.map((x,i)=>({x,i})).filter(x=>x.x[0]==="nft"&&x.x[1][1]==="rule");
    expect(rules).toHaveLength(6);
    expect(rules.every(x=>x.i<firstMaster)).toBe(true);
    expect(JSON.stringify(cmd)).toContain("02:aa:bb:cc:dd:ee");
    expect(JSON.stringify(cmd)).toContain("rp_lan_gw");
  });
  it("never enslaves Docker eth0, an RP host bridge, or changes default routes",()=>{
    const cmd=gatewayL2SetupPlan(input);
    const serialized=JSON.stringify(cmd);
    expect(serialized).not.toContain("docker0");
    expect(serialized).not.toContain("default");
    expect(serialized).not.toContain("route");
    expect(cmd.filter(x=>x[1].includes("master"))).toHaveLength(2);
  });
  it("rejects conflicting Gate or tenant identity",()=>{
    expect(()=>gatewayL2SetupPlan({...input,wireguard:{...input.wireguard,gateId:input.app.attachmentId}})).toThrow();
    expect(()=>gatewayL2SetupPlan({...input,wireguard:{...input.wireguard,tenantId:input.app.attachmentId}})).toThrow();
    expect(()=>gatewayL2SetupPlan({...input,wireguard:{...input.wireguard,clientTunnelAddress:"100.96.0.2/32"}})).toThrow();
  });
  it("cleanup restricts itself to three RP-owned L2 links and one firewall chain",()=>{
    const commands=gatewayL2CleanupPlan(input);
    expect(commands).toHaveLength(5);
    expect(commands.slice(0,3).every(x=>x[0]==="ip"&&x[1][0]==="link")).toBe(true);
    expect(JSON.stringify(commands)).not.toContain("eth1");
    expect(JSON.stringify(commands)).not.toContain("wg0");
    const other=gatewayL2SetupPlan({...input,app:{...input.app,tenantId:input.wireguard.gateId},
      wireguard:{...input.wireguard,tenantId:input.wireguard.gateId}});
    expect(other[0][1][2]).not.toBe(gatewayL2SetupPlan(input)[0][1][2]);
  });
});
