import {describe,it,expect} from "vitest";
import {inspectStaticRoutingClaim,readRpStaticTable} from "./remote-lan-static-routing";

const config={source:"192.168.50.44",gateway:"192.168.50.254",device:"rp-a-1234abcd",prefix:"192.168.50.0/24"};
const rule="0: from all lookup local\n18015: from 192.168.50.44 lookup 20015\n32766: from all lookup main";
const route="192.168.50.0/24 dev rp-a-1234abcd scope link\ndefault via 192.168.50.254 dev rp-a-1234abcd";
describe("app-scoped static routing ownership and safe revocation",()=>{
  it("recognizes exact current link/source/gateway and emits targeted cleanup",()=>{
    const state=inspectStaticRoutingClaim(config,rule,route);
    expect(state.fullyConfigured).toBe(true);
    expect(state.cleanup).toEqual([
      ["-4","rule","del","pref","18015","from","192.168.50.44/32","lookup","20015"],
      ["-4","route","del","default","via","192.168.50.254",
        "dev","rp-a-1234abcd","table","20015"],
      ["-4","route","del","192.168.50.0/24","dev","rp-a-1234abcd","table","20015"],
    ]);
  });
  it("permits empty snapshot and clean partial crash recovery",()=>{
    expect(inspectStaticRoutingClaim(config,"0: from all lookup local","")).toEqual({
      rulePresent:false,routePresent:false,fullyConfigured:false,cleanup:[]
    });
    const partial=inspectStaticRoutingClaim(config,rule,"");
    expect(partial.cleanup).toHaveLength(1);
    expect(partial.fullyConfigured).toBe(false);
    expect(inspectStaticRoutingClaim(config,"",route).cleanup).toHaveLength(2);
  });
  it("never deletes another source, gateway or app device in shared namespace",()=>{
    expect(()=>inspectStaticRoutingClaim(config,rule.replace(
      "192.168.50.44","192.168.50.45"),route)).toThrow(/different source/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route.replace(
      "192.168.50.254","192.168.50.1"))).toThrow(/foreign/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route.replace(
      "rp-a-1234abcd","eth0"))).toThrow(/unexpected routes|foreign/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route+"\n10.0.0.0/8 dev eth0"))
      .toThrow(/unexpected routes/);
    expect(()=>inspectStaticRoutingClaim(config,rule+"\n18015: from 10.0.0.5 lookup main",route))
      .toThrow(/Duplicate/);
  });
  it("accepts two exact owned routes, safely migrates legacy default and rejects collisions",()=>{
    const claim=inspectStaticRoutingClaim(config,rule,route);
    expect(claim.fullyConfigured).toBe(true);
    expect(claim.cleanup).toHaveLength(3);
    for(const bad of ["192.168.51.0/24 dev rp-a-1234abcd", "192.168.50.0/24 dev eth0",
      "192.168.50.0/24 via 192.168.50.254 dev rp-a-1234abcd",
      "192.168.50.0/24 dev rp-a-1234abcd\n192.168.51.0/24 dev rp-a-1234abcd"])
      expect(()=>inspectStaticRoutingClaim(config,rule,bad+"\n"+route.split("\n")[1])).toThrow();
    const legacy=inspectStaticRoutingClaim(config,rule,route.split("\n")[1]);
    expect(legacy.fullyConfigured).toBe(false);
    expect(legacy.cleanup).toHaveLength(2);
  });
  it("requires RP-owned interface before emitting any destructive action",()=>{
    expect(()=>inspectStaticRoutingClaim({...config,device:"eth0"},rule,route)).toThrow();
    expect(()=>inspectStaticRoutingClaim({...config,source:"1.1.1.1;rm"},rule,route)).toThrow();
  });
});


describe("Static table 20015 read in tenant netns",()=>{
  const missing="Error: ipv4: FIB table does not exist.\nDump terminated.";
  const read=(status:number,stderr="",stdout="")=>readRpStaticTable(args=>{
    expect(args).toEqual(["-4","route","show","table","20015"]);
    return {status,stderr,stdout};
  });
  it("first Static attach recognizes the precise missing empty FIB table",()=>{
    expect(read(2,missing)).toBe("");
    expect(inspectStaticRoutingClaim(config,"0: from all lookup local",read(2,missing))
      .fullyConfigured).toBe(false);
  });
  it("accepts actual Linux/nsenter iproute2 status 2 with unpunctuated Dump terminated and trailing newline",()=>{
    const actual = "Error: ipv4: FIB table does not exist.\nDump terminated\n";
    expect(read(2,actual,"")).toBe("");
    expect(inspectStaticRoutingClaim(config,"0: from all lookup local",read(2,actual))
      .fullyConfigured).toBe(false);
    expect(()=>read(2,actual+"Permission denied\n")).toThrow(/inspection failed/);
  });
  it("recovery after restart removes an RP-owned rule with an absent table",()=>{
    const state=inspectStaticRoutingClaim(config,rule,read(2,missing));
    expect(state.cleanup).toEqual([
      ["-4","rule","del","pref","18015","from","192.168.50.44/32","lookup","20015"],
    ]);
  });
  it("DHCP to Static transition accepts an empty snapshot but never foreign rules",()=>{
    const empty=read(2,missing);
    expect(inspectStaticRoutingClaim(config,"",empty).cleanup).toEqual([]);
    expect(()=>inspectStaticRoutingClaim(config,
      rule.replace("192.168.50.44","192.168.50.99"),empty)).toThrow(/different source/);
    expect(()=>inspectStaticRoutingClaim(config,rule,
      read(0,"","default via 192.168.50.254 dev eth0"))).toThrow(/foreign/);
  });
  it("does not reinterpret permissions, unknown stderr or missing process as absence",()=>{
    for(const [status,stderr] of [
      [1,"RTNETLINK answers: Operation not permitted"],
      [2,"Error: ipv4: FIB table does not exist.\nUnexpected output."],
      [2,"Permission denied"],[0,"Permission denied"],[1,missing],[2,""],
    ] as const) expect(()=>read(status,stderr)).toThrow(/inspection failed/);
    expect(()=>readRpStaticTable(()=>({status:null,error:new Error("spawn EACCES")})))
      .toThrow(/EACCES/);
    expect(read(0,"",route)).toBe(route);
  });
});
