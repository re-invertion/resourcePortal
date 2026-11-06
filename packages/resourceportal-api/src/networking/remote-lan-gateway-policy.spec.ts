import { describe, expect, it } from "vitest";
import { applyGateLeaseSnapshot, validateGateLeaseSnapshot, type GateLeaseSnapshot } from "./remote-lan-gateway-policy";
import { boundLanSource } from "./remote-lan-source-guard";
import type { GateRuntimeConfig } from "./gate-runtime.types";
const now = 2_000_000_000_000;
const app = {
  attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  gateId: "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  networkId: "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc",
  singleAppId: "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd",
  overlayCidr: "10.200.10.0/24",
  lanCidr: "192.168.60.0/24",
  serviceName: "rp_aaaaaaaa_bbbb_4ccc_8ddd_eeeeeeeeeeee_app",
  macAddress: "02:aa:bb:cc:dd:ee", configurationRevision: 1,
  addressMode: "DHCP" as const,
  status: "Provisioning",
  verifiedAddress: null, leaseExpiresAt: null,
};
const config: GateRuntimeConfig = {
  gateId: app.gateId, listenPort: 51820, serverTunnelAddress: "10.253.0.1/30",
  clientTunnelAddress: "10.253.0.2/30", peerPublicKey: "x",
  privateKeyPath: "/run/secrets/gate-private-key",
  rpOverlayCidrs: [app.overlayCidr], remoteLanAttachments: [app],
};
const grant = {
  attachmentId: app.attachmentId, tenantId: app.tenantId,
  gateId: app.gateId, networkId: app.networkId, macAddress: app.macAddress, configurationRevision: 1,
  status: "Active", verifiedAddress: "192.168.60.51",
  leaseExpiresAt: new Date(now + 3_600_000).toISOString(),
  lastVerifiedAt: new Date(now - 2_000).toISOString(),
};
const snapshot: GateLeaseSnapshot = { gateId: app.gateId, issuedAt: new Date(now).toISOString(), grants: [grant] };
describe("Gateway dynamic lease policy (not part of Swarm service spec)", () => {
  it("updates only verified DHCP IP in the existing Gate identity, with short expiry", () => {
    expect(validateGateLeaseSnapshot(snapshot, config, now)).toBe(true);
    const merged = applyGateLeaseSnapshot(config, snapshot, now);
    const address = boundLanSource(merged.remoteLanAttachments[0], now);
    expect(address?.ip).toBe("192.168.60.51");
    expect(address?.timeoutSeconds).toBe(43);
    expect(config.remoteLanAttachments[0].verifiedAddress).toBeNull();
  });
  it("rejects stale and forged lease evidence, wrong Gate/tenant/MAC/network and revision-like identity", () => {
    for (const bad of [
      { ...snapshot, gateId: "another" },
      { ...snapshot, issuedAt: new Date(now - 46_000).toISOString() },
      { ...snapshot, issuedAt: new Date(now + 6_000).toISOString() },
      { ...snapshot, grants: [] },
      { ...snapshot, grants: [grant, grant] },
      { ...snapshot, grants: [{ ...grant, tenantId: "wrong" }] },
      { ...snapshot, grants: [{ ...grant, gateId: "wrong" }] },
      { ...snapshot, grants: [{ ...grant, networkId: "wrong" }] },
      { ...snapshot, grants: [{ ...grant, macAddress: "02:ee:ee:ee:ee:ee" }] },
      { ...snapshot, grants: [{ ...grant, configurationRevision: 2 }] },
    ]) {
      expect(applyGateLeaseSnapshot(config, bad, now).remoteLanAttachments).toEqual(config.remoteLanAttachments);
    }
    for (const badGrant of [
      { ...grant, status: "Provisioning" },
      { ...grant, lastVerifiedAt: new Date(now - 46_000).toISOString() },
      { ...grant, lastVerifiedAt: new Date(now + 6_000).toISOString() },
      { ...grant, leaseExpiresAt: new Date(now - 1).toISOString() },
      { ...grant, verifiedAddress: "192.168.60.255" },
      { ...grant, verifiedAddress: "192.168.61.1" },
      { ...grant, verifiedAddress: null },
    ]) {
      const output = applyGateLeaseSnapshot(config, { ...snapshot, grants: [badGrant] }, now);
      expect(boundLanSource(output.remoteLanAttachments[0], now)).toBeNull();
    }
    expect(applyGateLeaseSnapshot(config, null, now)).toBe(config);
    expect(boundLanSource(applyGateLeaseSnapshot(config, snapshot, now + 46_000)
      .remoteLanAttachments[0], now + 46_000)).toBeNull();
  });
  it("preserves authorized static IP even without DHCP evidence, but never allows new static source", () => {
    const fixed = { ...config, remoteLanAttachments: [{ ...app, addressMode: "Static" as const,
      staticAddress: "192.168.60.60/24" }] };
    const output = applyGateLeaseSnapshot(fixed, snapshot, now);
    expect(boundLanSource(output.remoteLanAttachments[0], now)).toEqual({ip: "192.168.60.60"});
  });
});
