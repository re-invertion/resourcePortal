import { describe, it, expect } from "vitest";
import { gretapSetupCommands, type RemoteLanTunnel } from "./remote-lan-l2-transport";

const params: RemoteLanTunnel = {
  attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  gateId: "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  serverTunnelAddress: "10.250.1.1/30",
  clientTunnelAddress: "10.250.1.2/30",
  interface: "wg0",
  side: "resourceportal",
};

describe("remote Ethernet-over-WireGuard tunnel planning", () => {
  it("creates matching GRE identity with opposite underlay endpoints", () => {
    const rp = gretapSetupCommands(params);
    const gate = gretapSetupCommands({...params,interface:"rp-gate",side:"gate"});
    expect(rp[0][1][2]).toBe(gate[0][1][2]);
    expect(rp[0][1]).toContain("10.250.1.1");
    expect(rp[0][1]).toContain("10.250.1.2");
    expect(gate[0][1].indexOf("10.250.1.2")).toBeLessThan(gate[0][1].indexOf("10.250.1.1"));
    expect(rp[0][1]).toContain("wg0");
    expect(gate[0][1]).toContain("rp-gate");
  });
  it("binds tunnel identity to tenant, Gate and app", () => {
    const base = gretapSetupCommands(params)[0][1];
    for(const key of ["tenantId","gateId","attachmentId"] as const){
      const altered = gretapSetupCommands({...params,[key]:"aaaaaaaa-bbbb-4ccc-8ddd-999999999999"})[0][1];
      expect(altered[2]).not.toBe(base[2]);
    }
  });
  it("rejects other interfaces, identical endpoints or broad underlay prefixes", () => {
    expect(()=>gretapSetupCommands({...params,interface:"rp-gate"})).toThrow();
    expect(()=>gretapSetupCommands({...params,clientTunnelAddress:params.serverTunnelAddress})).toThrow();
    expect(()=>gretapSetupCommands({...params,clientTunnelAddress:"10.250.1.2/24"})).toThrow();
    expect(()=>gretapSetupCommands({...params,clientTunnelAddress:"10.250.2.2/30"})).toThrow();
    expect(()=>gretapSetupCommands({...params,clientTunnelAddress:"10.250.1.3/30"})).toThrow();
  });
  it("never implicitly alters physical NICs, creates a bridge or uses an unencrypted path", () => {
    const commands = gretapSetupCommands(params);
    const flat = JSON.stringify(commands);
    expect(flat).not.toMatch(/eth0|bridge|brctl|iptables|default/);
    expect(commands.every(command => command[0] === "ip")).toBe(true);
  });
});
