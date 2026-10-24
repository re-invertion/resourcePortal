import {describe,it,expect} from "vitest";
import {managedBridgeName,observeManagedUplink,preflightManagedUplink,type ManagedUplinkSnapshot, type ManagedUplinkPreflightSnapshot} from "./remote-lan-managed-uplink";
const gateId="aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const name=managedBridgeName(gateId,"eth0");
const now="2026-10-24T21:00:00.000Z";
const make=():ManagedUplinkSnapshot=>({
  gateId,device:"eth0",manager:"systemd-networkd",networkManagerOwnsDevice:true,
  checkpointVerified:true,watchdogArmed:true,rollbackTested:true,controlPlaneReachable:true,
  observedAt:now,agentVersion:"gate-l2-v2",
  links:[
    {ifname:"eth0",link_type:"ether",operstate:"UP",ifindex:2,master:name},
    {ifname:name,link_type:"ether",operstate:"UP",ifindex:5,
      ifalias:"rp-lan:"+gateId+":eth0",linkinfo:{info_kind:"bridge"}},
  ],
  addresses:[{ifname:"eth0",addr_info:[]},
    {ifname:name,addr_info:[{family:"inet",local:"192.168.100.11",prefixlen:24,scope:"global"}]}],
  routes:[{dst:"default",dev:name,gateway:"192.168.100.1"}],
});
const preflight=():ManagedUplinkPreflightSnapshot=>({
  ...make(),links:[{ifname:"eth0",ifindex:2,link_type:"ether",operstate:"UP"}],
  addresses:[{ifname:"eth0",addr_info:[{family:"inet",local:"192.168.100.11",prefixlen:24}]}],
  routes:[{dst:"default",dev:"eth0",gateway:"192.168.100.1"}],
  managedNetworkFile:"/etc/systemd/network/10-eth0.network",ipv4DhcpOwned:true,
  competingNetworkManagers:[],
});
describe("managed uplink preflight",()=>{
  it("returns only a non-executable plan requiring external rollback",()=>{
    expect(preflightManagedUplink(preflight(),Date.parse(now))).toMatchObject({
      state:"Preflight",bridge:name,physicalInterface:"eth0",canApply:false,
      networkCidr:"192.168.100.0/24",existingGateway:"192.168.100.1",
      requiresIndependentRollbackWatchdog:true
    });
  });
  it("refuses ambiguous managers, NIC master, IPv6 management and off-link default route",()=>{
    const competing=preflight();competing.competingNetworkManagers=["NetworkManager"];
    expect(()=>preflightManagedUplink(competing,Date.parse(now))).toThrow(/unique/);
    const enslaved=preflight();enslaved.links[0].master="br-foreign";
    expect(()=>preflightManagedUplink(enslaved,Date.parse(now))).toThrow(/Unsafe/);
    const ip6=preflight();ip6.addresses[0].addr_info?.push({
      family:"inet6",local:"2001:db8::12",scope:"global"});
    expect(()=>preflightManagedUplink(ip6,Date.parse(now))).toThrow(/IPv6/);
    const route=preflight();route.routes=[{dst:"default",dev:"eth0",gateway:"10.2.0.1"}];
    expect(()=>preflightManagedUplink(route,Date.parse(now))).toThrow(/off-link/);
  });
});
describe("Managed Shared Uplink LAN observation (fail closed)",()=>{
  it("reports only the Gate-verified CIDR and mask, not user input",()=>{
    expect(observeManagedUplink(make(),Date.parse(now))).toMatchObject({
      state:"Ready",protocol:1,physicalInterface:"eth0",bridge:name,
      networkCidr:"192.168.100.0/24",netmask:"255.255.255.0",
      gateway:"192.168.100.1",prefix:24,discoveryMethod:"host-verified"
    });
  });
  it("rejects missing watchdog, rollback evidence and control heartbeat",()=>{
    for(const field of ["watchdogArmed","rollbackTested","checkpointVerified",
      "controlPlaneReachable","networkManagerOwnsDevice"] as const){
      const obj=make();obj[field]=false;
      expect(()=>observeManagedUplink(obj,Date.parse(now))).toThrow();
    }
  });
  it("rejects unsupported managers and stale reports",()=>{
    const obj=make();obj.manager="NetworkManager";
    expect(()=>observeManagedUplink(obj,Date.parse(now))).toThrow(/systemd-networkd/);
    expect(()=>observeManagedUplink(make(),Date.parse(now)+61_000)).toThrow(/Stale/);
  });
  it("rejects bridges with foreign ports and unowned bridges",()=>{
    const obj=make();obj.links=[...obj.links,{ifname:"rogue",master:name,ifindex:7}];
    expect(()=>observeManagedUplink(obj,Date.parse(now))).toThrow(/membership/);
    const impostor=make();impostor.links[1].ifalias="foreign";
    expect(()=>observeManagedUplink(impostor,Date.parse(now))).toThrow(/Unowned/);
  });
  it("rejects physical NIC addressing and incorrect gateway routing",()=>{
    const obj=make();obj.addresses[0].addr_info=[{family:"inet6",local:"fe80::1"}];
    expect(()=>observeManagedUplink(obj,Date.parse(now))).toThrow(/Physical/);
    const wrong=make();wrong.routes=[{dst:"default",dev:"eth0",gateway:"192.168.100.1"}];
    expect(()=>observeManagedUplink(wrong,Date.parse(now))).toThrow(/default/);
    const other=make();other.routes=[{dst:"default",dev:name,gateway:"192.168.101.1"}];
    expect(()=>observeManagedUplink(other,Date.parse(now))).toThrow(/gateway/);
  });
  it("rejects ambiguous host IPs and duplicated default routes",()=>{
    const obj=make();obj.addresses[1].addr_info?.push({
      family:"inet",local:"192.168.100.12",prefixlen:24
    });
    expect(()=>observeManagedUplink(obj,Date.parse(now))).toThrow(/unique/);
    const other=make();other.routes=[...other.routes,{dst:"default",dev:name,gateway:"192.168.100.1"}];
    expect(()=>observeManagedUplink(other,Date.parse(now))).toThrow(/default/);
  });
  it("never authorizes invalid Gate identity or interface",()=>{
    expect(()=>managedBridgeName("invalid","eth0")).toThrow();
    expect(()=>managedBridgeName(gateId,"eth0;rm")).toThrow();
  });
});