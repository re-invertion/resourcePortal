import { describe,expect,it } from "vitest";
import { RemoteLanGatewayController } from "./remote-lan-gateway-controller";
import { gatewayL2SetupPlan } from "./remote-lan-gateway-plan";
import { planGatewayRuntimeAttachments } from "./remote-lan-gateway-resolver";
import type { GateRuntimeConfig } from "./gate-runtime.types";

const attachment = {
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  networkId:"aaaaaaaa-bbbb-4ccc-8ddd-121212121212",
  overlayCidr:"10.200.42.0/24",
  serviceName:"rp_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee_homeassistant",
  macAddress:"02:aa:bb:cc:dd:ee",
};
const config: GateRuntimeConfig = {
  gateId:attachment.gateId, listenPort:51820,
  serverTunnelAddress:"100.96.0.1/30",clientTunnelAddress:"100.96.0.2/30",
  peerPublicKey:"key", privateKeyPath:"/key",
  rpOverlayCidrs:[attachment.overlayCidr],
  remoteLanAttachments:[attachment],
};
const interfaces = [{name:"eth1",address:"10.200.42.20"}];
const tasks = new Map([[attachment.serviceName,["10.200.42.41"]]]);
type Link = {ifname:string; ifalias?:string; master?:string; linkinfo?:{info_kind:string}};
function host(fail?: (binary:string,args:string[])=>boolean) {
  const devices:Link[]=[];
  const commands:string[]=[];
  let table=false;
  const invoke = (binary:string,args:string[],_allowFailure=false) => {
    void _allowFailure;
    commands.push(binary+" "+args.join(" "));
    if (fail?.(binary,args)) throw new Error("Injected command failure");
    const [action,...rest]=args;
    if(binary==="ip" && action==="link" && rest[0]==="add"){
      const name=rest[1];
      const type=rest[3];
      devices.push({ifname:name,linkinfo:{info_kind:type}});
    }
    if(binary==="ip"&& action==="link"&&rest[0]==="set"&&rest[1]==="dev"&&args.includes("alias")){
      const dev=devices.find(d=>d.ifname===rest[2]);
      if(dev) dev.ifalias=args.at(-1);
    }
    if(binary==="ip"&&action==="link"&&rest[0]==="delete"){
      const i=devices.findIndex(d=>d.ifname===rest[1]);
      if(i>=0) devices.splice(i,1);
    }
    if(binary==="nft"&&action==="add"&&rest[0]==="table") table=true;
    if(binary==="nft"&&action==="list"&&rest[0]==="table")
      return {status:table?0:1,stdout:"",stderr:table?"":"not found"};
    if(binary==="ip"&&action==="-d"&&rest[0]==="-j")
      return {status:0,stdout:JSON.stringify(devices),stderr:""};
    return {status:0,stdout:"",stderr:""};
  };
  return {controller:new RemoteLanGatewayController(invoke),devices,commands,invoke};
}
describe("RP Gateway authenticated remote LAN reconciliation",()=>{
  it("requires a deliberate runtime opt-in before creating a single bridge",()=>{
    const f=host();
    expect(()=>f.controller.reconcile(config,interfaces,tasks,false)).toThrow(/not certified/);
    expect(f.devices).toEqual([]);
    expect(f.controller.reconcile(config,interfaces,tasks,true)).toBe(1);
    expect(f.devices.some(x=>x.linkinfo?.info_kind==="bridge")).toBe(true);
    expect(f.controller.reconcile(config,interfaces,tasks,true)).toBe(1);
    expect(f.commands.filter(c=>c.includes("link add")).length).toBe(3);
  });
  it("deletes both tunnels on revocation, and no other physical device",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const removed=f.controller.reconcile({...config,remoteLanAttachments:[]},interfaces,tasks,true);
    expect(removed).toBe(0);
    expect(f.devices).toEqual([]);
    expect(f.commands.join("\n")).not.toContain("eth0");
    expect(f.commands.filter(c=>c.includes("link delete"))).toHaveLength(3);
  });
  it("removes a live bridge when the desired task becomes ambiguous",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    expect(()=>f.controller.reconcile(config,interfaces,
      new Map([[attachment.serviceName,["10.200.42.41","10.200.42.42"]]]),true)).toThrow();
    expect(f.devices).toHaveLength(0);
  });
  it("recovers only owner-tagged stale links after a gateway process restart",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const restarted=new RemoteLanGatewayController(f.invoke);
    expect(restarted.reconcile(config,interfaces,tasks,true)).toBe(1);
    expect(f.devices).toHaveLength(3);
    expect(f.commands.filter(c=>c.includes("link delete"))).toHaveLength(3);
  });
  it("rolls back all links when a tunnel alias or firewall command fails",()=>{
    for (const failure of [
      (binary:string,args:string[]) => binary==="ip" && args.includes("rp-lan-app:"+attachment.attachmentId),
      (binary:string,args:string[]) => binary==="nft" && args[1]==="rule",
    ]) {
      const f=host(failure);
      expect(()=>f.controller.reconcile(config,interfaces,tasks,true)).toThrow(/Injected/);
      expect(f.devices).toEqual([]);
    }
  });
  it("refuses to delete a foreign tunnel even if the bridge is RP-owned",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const tunnel=f.devices.find(x=>x.ifalias==="rp-lan-app:"+attachment.attachmentId);
    if (!tunnel) throw new Error("Test fixture missing app tunnel");
    tunnel.ifalias="foreign";
    expect(()=>f.controller.reconcile({...config,remoteLanAttachments:[]},interfaces,tasks,true))
      .toThrow(/foreign Gateway GRETAP/);
    expect(f.devices).toHaveLength(3);
  });
  it("revokes verified orphaned GRETAP endpoints when their bridge has disappeared",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const bridge=f.devices.findIndex(x=>x.linkinfo?.info_kind==="bridge");
    expect(bridge).toBeGreaterThanOrEqual(0);
    f.devices.splice(bridge,1);
    expect(f.devices).toHaveLength(2);
    expect(f.controller.reconcile({...config,remoteLanAttachments:[]},interfaces,tasks,true)).toBe(0);
    expect(f.devices).toEqual([]);
  });
  it("refuses to revoke an RP-tagged tunnel moved under a foreign bridge",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const tunnel=f.devices.find(x=>x.ifalias==="rp-lan-app:"+attachment.attachmentId);
    if (!tunnel) throw new Error("Test fixture missing app tunnel");
    tunnel.master="unrelated-bridge";
    expect(()=>f.controller.reconcile({...config,remoteLanAttachments:[]},interfaces,tasks,true))
      .toThrow(/foreign bridge/);
    expect(f.devices).toHaveLength(3);
  });
  it("does not modify an occupied GRETAP name on a fresh grant",()=>{
    const f=host();
    const [input]=planGatewayRuntimeAttachments(config,interfaces,tasks);
    const appName=gatewayL2SetupPlan(input).find(([bin,args])=>
      bin==="ip" && args[0]==="link" && args[1]==="add" && args.includes("gretap"))?.[1][2];
    if (!appName) throw new Error("Test fixture missing tunnel name");
    f.devices.push({ifname:appName,linkinfo:{info_kind:"gretap"},ifalias:"foreign"});
    expect(()=>f.controller.reconcile(config,interfaces,tasks,true)).toThrow(/occupied/);
    expect(f.devices).toHaveLength(1);
    expect(f.commands.filter(c=>c.includes("link delete"))).toHaveLength(0);
  });
  it("never deletes an unowned bridge with an identical name",()=>{
    const f=host();
    f.controller.reconcile(config,interfaces,tasks,true);
    const bridge=f.devices.find(x=>x.linkinfo?.info_kind==="bridge");
    if(!bridge) throw new Error("Test fixture missing bridge");
    bridge.ifalias="untrusted";
    expect(()=>f.controller.reconcile({...config,remoteLanAttachments:[]},interfaces,tasks,true)).toThrow(/unrelated/);
    expect(f.devices).not.toEqual([]);
  });
});
