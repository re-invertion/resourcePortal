import { describe, expect, it } from "vitest";
import {
  issueRemoteLanAuthorizationLease, remoteLanAuthorizationExpiry,
  REMOTE_LAN_AUTHORIZATION_TTL_MS,
} from "./remote-lan-authorization-lease";
const now = 2_000_000_000_000;
const gateId = "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb";
const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const grant = {
  attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa", tenantId, gateId,
  singleAppId: "aaaaaaaa-bbbb-4ccc-8ddd-dddddddddddd",
  networkId: "aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc",
  macAddress: "02:aa:bb:cc:dd:ee", configurationRevision: 2,
};
const candidate = { ...grant, status: "Active", lastVerifiedAt: new Date(now - 1_000) };
const proof = { ...grant, gatewayTunnelOwned: true, bridgeOwned: true,
  macLearnedOnTunnel: true };
const nonce = "c".repeat(64);
const args = { gateId, tenantId, agentVersion: "gate-l2-v4",
  nonce, candidates: [candidate], proofs: [proof], now };
describe("bounded offline continuation is independent from DHCP", () => {
  it("issues nonce-and-revision-bound grants only for already proved Active paths", () => {
    expect(issueRemoteLanAuthorizationLease(args)).toEqual({
      protocol: 1, gateId, tenantId, nonce, issuedAtMs: now,
      ttlSeconds: REMOTE_LAN_AUTHORIZATION_TTL_MS / 1000,
      grants: [grant],
    });
    expect(issueRemoteLanAuthorizationLease({ ...args, agentVersion:"gate-l2-v3" })).toBeNull();
    expect(issueRemoteLanAuthorizationLease({ ...args, nonce: "replay" })).toBeNull();
    for(const changed of [
      { ...candidate, status: "Provisioning" },
      { ...candidate, configurationRevision: 3 },
      { ...candidate, lastVerifiedAt: new Date(now - 45_000) },
      { ...candidate, tenantId: "wrong" },
      { ...candidate, gateId: "wrong" },
    ]) {
      const issued = issueRemoteLanAuthorizationLease({
        ...args, candidates:[changed],
        proofs:[proof],
      });
      expect(issued?.grants).toEqual([]);
    }
    expect(issueRemoteLanAuthorizationLease({ ...args, proofs:
      [{...proof, macLearnedOnTunnel:false}] })?.grants).toEqual([]);
  });

  it("anchors Swarm continuation to a real persisted server decision, never a newer heartbeat",()=>{
    const gate = {gateId, tenantId, agentVersion:"gate-l2-v4",
      revokedAt:null, observedL2At:new Date(now+400_000),
      observedL2Diagnostic:{authorizationLease:{issuedAtMs:now,grants:[grant]}}};
    expect(remoteLanAuthorizationExpiry(gate,grant,now+300_000))
      .toBe(now+REMOTE_LAN_AUTHORIZATION_TTL_MS);
    expect(remoteLanAuthorizationExpiry(gate,grant,now+REMOTE_LAN_AUTHORIZATION_TTL_MS))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,agentVersion:"gate-l2-v3"},grant,now))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,revokedAt:new Date()},grant,now))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,observedL2Diagnostic:{authorizationLease:{
      issuedAtMs:now,grants:[{...grant,configurationRevision:1}]}}},grant,now))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,observedL2Diagnostic:{authorizationLease:{
      issuedAtMs:now,grants:[{...grant,macAddress:"02:ff:ff:ff:ff:ff"}]}}},grant,now))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,observedL2Diagnostic:{}},grant,now))
      .toBeNull();
    expect(remoteLanAuthorizationExpiry({...gate,observedL2Diagnostic:{
      authorizationLease:{issuedAtMs:now-601_000,grants:[grant]}}},grant,now))
      .toBeNull();
  });
});
