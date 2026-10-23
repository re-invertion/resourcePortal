import { describe, expect, it } from "vitest";
import { assertSafeGateLanInterface } from "./remote-lan-gate-preflight";

const links = [{ifname:"eth1",ifindex:3,link_type:"ether",operstate:"UP"}];
const ips = [{ifname:"eth1",addr_info:[]}];
const routes = [{dst:"default",dev:"eth0",gateway:"192.168.1.1"}];
describe("Gate physical LAN bridge preflight", () => {
  it("allows a dedicated unnumbered Ethernet interface", () => {
    expect(() => assertSafeGateLanInterface("eth1",links,ips,routes)).not.toThrow();
    expect(() => assertSafeGateLanInterface("eth1.42",
      [{...links[0],ifname:"eth1.42",linkinfo:{info_kind:"vlan"}}],
      [{ifname:"eth1.42",addr_info:[]}],routes)).not.toThrow();
  });
  it("rejects bridging Gate management, including IPv6-only addresses", () => {
    for(const family of ["inet","inet6"]) {
      expect(() => assertSafeGateLanInterface("eth1",links,
        [{ifname:"eth1",addr_info:[{family,local:"fe80::1"}]}],routes)).toThrow(/host IP/);
    }
    expect(() => assertSafeGateLanInterface("eth1",links,ips,
      [{dst:"default",dev:"eth1"}])).toThrow(/default route/);
  });
  it("rejects non-Ethernet, down and absent interfaces", () => {
    expect(() => assertSafeGateLanInterface("wlan0",[{...links[0],ifname:"wlan0",link_type:"none"}],ips,routes)).toThrow();
    expect(() => assertSafeGateLanInterface("eth1",[{...links[0],operstate:"DOWN"}],ips,routes)).toThrow();
    expect(() => assertSafeGateLanInterface("eth5",links,ips,routes)).toThrow();
  });
  it("rejects master/slave and tunnel interfaces", () => {
    expect(() => assertSafeGateLanInterface("eth1",[{...links[0],master:"br0"}],ips,routes)).toThrow();
    expect(() => assertSafeGateLanInterface("eth1",[{...links[0],linkinfo:{info_kind:"wireguard"}}],ips,routes)).toThrow();
    expect(() => assertSafeGateLanInterface("eth1",[...links,{ifname:"tap0",ifindex:5,master:"eth1"}],ips,routes)).toThrow();
  });
});
