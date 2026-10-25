import {describe,it,expect} from "vitest";
import {inspectStaticRoutingClaim} from "./remote-lan-static-routing";

const config={source:"192.168.50.44",gateway:"192.168.50.254",device:"rp-a-1234abcd"};
const rule="0: from all lookup local\n18015: from 192.168.50.44 lookup 20015\n32766: from all lookup main";
const route="default via 192.168.50.254 dev rp-a-1234abcd";
describe("app-scoped static routing ownership and safe revocation",()=>{
  it("recognizes exact current link/source/gateway and emits targeted cleanup",()=>{
    const state=inspectStaticRoutingClaim(config,rule,route);
    expect(state.fullyConfigured).toBe(true);
    expect(state.cleanup).toEqual([
      ["-4","rule","del","pref","18015","from","192.168.50.44/32","lookup","20015"],
      ["-4","route","del","default","via","192.168.50.254",
        "dev","rp-a-1234abcd","table","20015"],
    ]);
  });
  it("permits empty snapshot and clean partial crash recovery",()=>{
    expect(inspectStaticRoutingClaim(config,"0: from all lookup local","")).toEqual({
      rulePresent:false,routePresent:false,fullyConfigured:false,cleanup:[]
    });
    const partial=inspectStaticRoutingClaim(config,rule,"");
    expect(partial.cleanup).toHaveLength(1);
    expect(partial.fullyConfigured).toBe(false);
    expect(inspectStaticRoutingClaim(config,"",route).cleanup).toHaveLength(1);
  });
  it("never deletes another source, gateway or app device in shared namespace",()=>{
    expect(()=>inspectStaticRoutingClaim(config,rule.replace(
      "192.168.50.44","192.168.50.45"),route)).toThrow(/different source/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route.replace(
      "192.168.50.254","192.168.50.1"))).toThrow(/foreign/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route.replace(
      "rp-a-1234abcd","eth0"))).toThrow(/foreign/);
    expect(()=>inspectStaticRoutingClaim(config,rule,route+"\n10.0.0.0/8 dev eth0"))
      .toThrow(/unexpected routes/);
    expect(()=>inspectStaticRoutingClaim(config,rule+"\n18015: from 10.0.0.5 lookup main",route))
      .toThrow(/Duplicate/);
  });
  it("requires RP-owned interface before emitting any destructive action",()=>{
    expect(()=>inspectStaticRoutingClaim({...config,device:"eth0"},rule,route)).toThrow();
    expect(()=>inspectStaticRoutingClaim({...config,source:"1.1.1.1;rm"},rule,route)).toThrow();
  });
});
