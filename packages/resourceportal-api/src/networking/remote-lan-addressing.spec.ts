import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import {managedBridgeName} from "./remote-lan-managed-uplink";
import {normalizeLanAddress,verifiedManagedLan} from "./remote-lan-addressing";
const gate="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const cidr="192.168.50.0/24";
const now=Date.now();
const observation={
  protocol:1,gateId:gate,segmentId:createHash("sha256").update(gate+":eth0:"+cidr).digest("hex").slice(0,24),physicalInterface:"eth0",
  bridge:managedBridgeName(gate,"eth0"),networkCidr:cidr,gateway:"192.168.50.1",
  state:"Ready",observedAt:new Date(now).toISOString(),agentVersion:"gate-l2-v2",
};
describe("LAN DHCP and Static IPv4 addressing contract",()=>{
  it("defaults legacy records to DHCP without static options",()=>{
    expect(normalizeLanAddress({lanCidr:cidr})).toEqual({
      lanCidr:cidr,addressMode:"DHCP",staticAddress:null,staticGateway:null
    });
  });
  it("accepts one valid static address on observed subnet with distinct gateway",()=>{
    expect(normalizeLanAddress({lanCidr:cidr,addressMode:"Static",
      staticAddress:"192.168.50.44/24",staticGateway:"192.168.50.1"}))
      .toMatchObject({staticAddress:"192.168.50.44/24",addressMode:"Static"});
  });
  it("rejects unusable, spoofed or conflicting static IP settings",()=>{
    for(const address of ["192.168.50.0/24","192.168.50.255/24","192.168.51.5/24",
      "192.168.50.2/23","192.168.050.2/24"]) {
      expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"Static",
        staticAddress:address,staticGateway:"192.168.50.1"})).toThrow();
    }
    expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"Static",
      staticAddress:"192.168.50.2/24",staticGateway:"192.168.50.2"})).toThrow();
    expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"Static",
      staticAddress:"192.168.50.2/24",staticGateway:"10.10.10.1"})).toThrow();
    expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"Static",
      staticAddress:"192.168.50.2/24",staticGateway:"192.168.50.1"},
      ["192.168.50.2"])).toThrow();
  });
  it("DHCP mode refuses static options or invalid canonical network",()=>{
    expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"DHCP",
      staticAddress:"192.168.50.20/24"})).toThrow();
    expect(()=>normalizeLanAddress({lanCidr:"192.168.50.44/24"})).toThrow();
    expect(()=>normalizeLanAddress({lanCidr:cidr,addressMode:"Legacy"})).toThrow();
  });
  it("requires authenticated fresh segment evidence for managed uplink",()=>{
    expect(verifiedManagedLan(gate,"eth0",observation,new Date(now),now)).toEqual(observation);
    expect(()=>verifiedManagedLan(gate,"eth1",observation,new Date(now),now)).toThrow();
    expect(()=>verifiedManagedLan(gate,"eth0",observation,new Date(now-61000),now)).toThrow();
    expect(()=>verifiedManagedLan(gate,"eth0",{...observation,networkCidr:"10.1.0.0/16"},
      new Date(now),now)).toThrow();
    expect(()=>verifiedManagedLan(gate,"eth0",{...observation,agentVersion:"gate-l2-v1"},
      new Date(now),now)).toThrow();
  });
});
