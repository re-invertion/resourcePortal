import { describe, expect, it } from "vitest";
import {
  validateRemoteLanLeaseProof, type RemoteLanLeaseTarget,
  type AppDhcpProof, type GateDhcpProof,
} from "./remote-lan-dhcp-proof";

const now = Date.UTC(2026, 9, 23, 8, 35);
const target: RemoteLanLeaseTarget = {
  attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId: "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc",
  gateId: "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  macAddress: "02:aa:bb:cc:dd:ee",
  lanCidr: "192.168.50.0/24",
  transportRevision: 3,
  status: "Provisioning",
};
const shared = {
  attachmentId: target.attachmentId,
  tenantId: target.tenantId,
  singleAppId: target.singleAppId,
  gateId: target.gateId,
  transportRevision: 3,
  observedAtMs: now - 1000,
  macAddress: target.macAddress,
  assignedIp: "192.168.50.88",
  prefixLength: 24,
  dhcpServer: "192.168.50.1",
  leaseExpiresAtMs: now + 3_600_000,
};
const app: AppDhcpProof = { ...shared, appInterfaceUp: true, peerReachable: true };
const gate: GateDhcpProof = {
  ...shared, gateBridgeUp: true, wireguardHandshakeAtMs: now - 2000,
};
const validate = (a: AppDhcpProof = app, g: GateDhcpProof = gate,
  t: RemoteLanLeaseTarget = target) => validateRemoteLanLeaseProof(t,a,g,now);

describe("authenticated DHCP evidence contract", () => {
  it("requires matching fresh ACK and app lease before activation", () => {
    expect(validate()).toEqual({
      assignedIp: "192.168.50.88", macAddress: target.macAddress,
      dhcpServer: "192.168.50.1", leaseExpiresAt: new Date(shared.leaseExpiresAtMs),
    });
  });
  it("refuses stale, future or cross-tenant observations and old revisions", () => {
    expect(() => validate({...app, observedAtMs: now-31000})).toThrow();
    expect(() => validate(app,{...gate,observedAtMs:now+6000})).toThrow();
    expect(() => validate({...app,tenantId:"ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee"})).toThrow();
    expect(() => validate(app,{...gate,transportRevision:2})).toThrow();
    expect(() => validate(app,gate,{...target,status:"Revoking" as "Provisioning"})).toThrow();
  });
  it("rejects mismatched DHCP ACK, MAC spoofing and invalid leases", () => {
    expect(() => validate(app,{...gate,assignedIp:"192.168.50.89"})).toThrow();
    expect(() => validate({...app,macAddress:"02:aa:bb:cc:dd:ff"})).toThrow();
    expect(() => validate({...app,leaseExpiresAtMs:now+1000})).toThrow();
    expect(() => validate({...app,assignedIp:"192.168.50.0"},
      {...gate,assignedIp:"192.168.50.0"})).toThrow();
    expect(() => validate({...app,assignedIp:"192.168.50.255"},
      {...gate,assignedIp:"192.168.50.255"})).toThrow();
    expect(() => validate({...app,assignedIp:"192.168.51.12"},
      {...gate,assignedIp:"192.168.51.12"})).toThrow();
  });
  it("refuses disconnected links, stale encrypted tunnel and missing bridge", () => {
    expect(() => validate({...app,appInterfaceUp:false})).toThrow();
    expect(() => validate({...app,peerReachable:false})).toThrow();
    expect(() => validate(app,{...gate,gateBridgeUp:false})).toThrow();
    expect(() => validate(app,{...gate,wireguardHandshakeAtMs:now-60000})).toThrow();
  });
});
