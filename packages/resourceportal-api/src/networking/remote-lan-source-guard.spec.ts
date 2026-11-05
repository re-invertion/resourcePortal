import {describe, expect, it} from "vitest";
import {boundLanSource, lanIngressRules} from "./remote-lan-source-guard";

const base = {lanCidr:"192.168.50.0/24",addressMode:"DHCP",status:"Active",
  verifiedAddress:"192.168.50.25",leaseExpiresAt:new Date(2200000000000).toISOString()};
const now=2199996400000;

describe("verified LAN L2 source isolation",()=>{
  it("permits no arbitrary IPv4 source during DHCP bootstrap or without an active verified lease",()=>{
    for(const invalid of [
      {...base,status:"Provisioning"}, {...base,verifiedAddress:null},
      {...base,leaseExpiresAt:null}, {...base,leaseExpiresAt:"not-a-date"},
      {...base,leaseExpiresAt:new Date(now-10).toISOString()},
      {...base,verifiedAddress:"192.168.51.21"},
      {...base,verifiedAddress:"192.168.50.0"},
      {...base,verifiedAddress:"192.168.50.255"},
    ]) expect(boundLanSource(invalid,now)).toBeNull();
    const rules=lanIngressRules("rp_lan","rp_123456789abc","rp-l2-12345678",
      "02:aa:bb:cc:dd:ee",null).map(x=>x[1].join(" ")).join("\n");
    expect(rules).toContain("ether type arp drop");
    expect(rules).toContain("ether type ip drop");
    expect(rules).toContain("arp saddr ether != 02:aa:bb:cc:dd:ee drop");
    expect(rules).toContain("arp saddr ip 0.0.0.0 arp operation request accept");
    expect(rules).toContain("ip saddr 0.0.0.0 udp sport 68 udp dport 67 accept");
    expect(rules).toContain("ether type ip udp sport 67 drop");
  });
  it("enforces the exact DHCP lease using a kernel-expiring address set",()=>{
    const source=boundLanSource(base,now);
    expect(source).toEqual({ip:"192.168.50.25",timeoutSeconds:3600});
    const rules=lanIngressRules("rp_lan","rp_123456789abc","rp-l2-12345678",
      "02:aa:bb:cc:dd:ee",source);
    const serialized=JSON.stringify(rules);
    expect(serialized).toContain("rpip_123456789abc");
    expect(serialized).toContain("3600s");
    expect(serialized).toContain("arp\",\"saddr\",\"ip\",\"!=\",\"@rpip_");
    expect(serialized).toContain("ip\",\"saddr\",\"!=\",\"@rpip_");
    expect(serialized).toContain("ether\",\"type\",\"!=\",\"{\",\"arp");
  });
  it("limits Static to one explicitly granted address without expiring",()=>{
    expect(boundLanSource({lanCidr:base.lanCidr,addressMode:"Static",
      status:"Provisioning",staticAddress:"192.168.50.25/24"},now))
      .toEqual({ip:"192.168.50.25"});
    expect(boundLanSource({lanCidr:base.lanCidr,addressMode:"Static",
      status:"Provisioning",staticAddress:"192.168.50.25/25"},now)).toBeNull();
  });
});
