import { describe, expect, it, vi } from "vitest";
import { setupRemoteLanGateway, type GatewayCommand } from "./remote-lan-gateway-startup";
import type { GateRuntimeConfig } from "./gate-runtime.types";

const config={
  gateId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  peerPublicKey:"peer",privateKeyPath:"/run/secrets/gate-private-key",
  listenPort:51820,clientTunnelAddress:"10.253.0.2/30",
  serverTunnelAddress:"10.253.0.1/30",
  rpOverlayCidrs:[],remoteLanAttachments:[],
} satisfies GateRuntimeConfig;

describe("actual Swarm Gateway runner startup commands",()=>{
  it("starts its L2-only WireGuard after a read-only forwarding check",()=>{
    const commands:Array<{program:string;args:string[]}>=[];
    const run:GatewayCommand=(program,args)=>{
      commands.push({program,args});
      return {status:0,stdout:program==="sysctl"?"0":"",stderr:""};
    };
    setupRemoteLanGateway(config,run);
    expect(commands[0]).toEqual({program:"sysctl",args:["-n","net.ipv4.ip_forward"]});
    expect(commands.some(x=>x.program==="sysctl" && x.args.includes("-w"))).toBe(false);
    expect(commands.some(x=>x.program==="ip"&&x.args.includes("route"))).toBe(false);
    expect(commands.find(x=>x.program==="wg")?.args).toContain("10.253.0.2/32");
    expect(commands.at(-1)?.args).toEqual(["link","set","mtu","1380","up","dev","wg0"]);
  });
  it("refuses to create any WG device if Swarm left forwarding enabled",()=>{
    const run=vi.fn<GatewayCommand>(()=>({status:0,stdout:"1",stderr:""}));
    expect(()=>setupRemoteLanGateway(config,run)).toThrow(/requires net.ipv4.ip_forward=0/);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("fails closed for an unreadable namespace sysctl",()=>{
    const run:GatewayCommand=(program)=>{
      if(program==="sysctl") throw new Error("Permission denied");
      return {status:0,stdout:"",stderr:""};
    };
    expect(()=>setupRemoteLanGateway(config,run)).toThrow(/Permission denied/);
  });
});
