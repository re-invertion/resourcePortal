import {describe,expect,it} from "vitest";
import {remoteLanIngressChain,remoteLanIngressFilterPlan,remoteLanIngressFilterCleanup} from "./remote-lan-l2-filter";
import type {RemoteLanIngressFilter} from "./remote-lan-l2-filter";
import {createHash} from "node:crypto";
const input:RemoteLanIngressFilter={
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  gretapDevice:"",
  allowedMac:"02:aa:bb:cc:dd:ee",
};
input.gretapDevice="rp-l2-"+createHash("sha256").update(
  [input.tenantId,input.gateId,input.attachmentId].join(":")).digest("hex").slice(0,8);
describe("Gate application L2 bridge ingress filter",()=>{
  it("enforces MAC, VLAN, IPv6, DHCP server and STP restrictions before bridge membership",()=>{
    const cmds=remoteLanIngressFilterPlan(input);
    expect(cmds).toHaveLength(7);
    const flat=JSON.stringify(cmds);
    expect(flat).toContain("02:aa:bb:cc:dd:ee");
    expect(flat).toContain("vlan");
    expect(flat).toContain("0x88a8");
    expect(flat).toContain("ip6");
    expect(flat).toContain("67");
    expect(flat).toContain("01:80:c2:00:00:00");
    expect(cmds.every(([binary])=>binary==="nft")).toBe(true);
  });
  it("does not allow a tunnel from another attachment or an arbitrary NIC",()=>{
    expect(()=>remoteLanIngressChain({...input,gretapDevice:"eth0"})).toThrow();
    expect(()=>remoteLanIngressChain({...input,tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff"})).toThrow();
    expect(()=>remoteLanIngressChain({...input,allowedMac:"01:aa:bb:cc:dd:ee"})).toThrow();
  });
  it("deletes only the owned per-app filter chain",()=>{
    const [cmd]=remoteLanIngressFilterCleanup(input);
    expect(cmd[1]).toEqual(["delete","chain","bridge","rp_lan",remoteLanIngressChain(input)]);
    expect(JSON.stringify(cmd)).not.toMatch(/flush|delete table/);
  });
});
