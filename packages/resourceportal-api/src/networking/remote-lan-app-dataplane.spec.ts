import {describe,expect,it} from "vitest";
import {
  appGretapCommands, appGretapCleanupCommands, gatewayL2BridgeCommands, type AppL2Tunnel,
} from "./remote-lan-app-dataplane";
const input: AppL2Tunnel={
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  appOverlayIp:"10.200.0.14",
  gatewayOverlayIp:"10.200.0.33",
  overlayCidr:"10.200.0.0/24",
  overlayInterface:"eth1",
  macAddress:"02:aa:bb:cc:dd:ee",
  side:"app",
};
describe("RP application Ethernet endpoint plan",()=>{
  it("gives app and gateway matching GRE identities with reversed underlay IPs",()=>{
    const app=appGretapCommands(input);
    const gateway=appGretapCommands({...input,side:"gateway"});
    expect(app[0][1][2]).toBe(gateway[0][1][2]);
    expect(app[0][1]).toContain(input.appOverlayIp);
    expect(gateway[0][1]).toContain(input.gatewayOverlayIp);
    expect(app[0][1].indexOf(input.appOverlayIp)).toBeLessThan(app[0][1].indexOf(input.gatewayOverlayIp));
    expect(gateway[0][1].indexOf(input.gatewayOverlayIp)).toBeLessThan(gateway[0][1].indexOf(input.appOverlayIp));
    expect(JSON.stringify(app)).toContain(input.macAddress);
    expect(JSON.stringify(gateway)).not.toContain(input.macAddress);
  });
  it("refuses foreign overlay IPs, unsafe interfaces and invalid MAC",()=>{
    expect(()=>appGretapCommands({...input,appOverlayIp:"192.168.1.44"})).toThrow();
    expect(()=>appGretapCommands({...input,gatewayOverlayIp:input.appOverlayIp})).toThrow();
    expect(()=>appGretapCommands({...input,overlayInterface:"eth0;shutdown"})).toThrow();
    expect(()=>appGretapCommands({...input,macAddress:"01:aa:bb:cc:dd:ee"})).toThrow();
    expect(()=>appGretapCommands({...input,macAddress:"00:aa:bb:cc:dd:ee"})).toThrow();
  });
  it("isolates GRE keys and interfaces across application IDs, even on overlapping overlay ranges",()=>{
    const other=appGretapCommands({...input,tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"});
    expect(other[0][1][2]).not.toBe(appGretapCommands(input)[0][1][2]);
  });
  it("creates one per-app gateway bridge and does not modify shared overlay interfaces",()=>{
    const commands=gatewayL2BridgeCommands({...input,side:"gateway"});
    expect(commands).toHaveLength(4);
    expect(commands[0][1]).toContain("bridge");
    expect(JSON.stringify(commands)).not.toContain("eth1");
    expect(JSON.stringify(commands)).not.toContain("docker0");
    const cleanup=appGretapCleanupCommands(input);
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0][1].slice(0,2)).toEqual(["link","delete"]);
  });
});
