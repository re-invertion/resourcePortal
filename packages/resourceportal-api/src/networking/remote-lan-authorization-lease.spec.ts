import { describe, expect, it } from "vitest";
import {
  issueRemoteLanAuthorizationLease, remoteLanAuthorizationExpiry,
  retainedRemoteLanAuthorization,
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

  it("keeps only the original unexpired grant during a 443s API outage recovery",()=>{
    const start=now-443_000;
    const gate={gateId,tenantId,agentVersion:"gate-l2-v4",revokedAt:null,
      observedL2Diagnostic:{authorizationLease:{issuedAtMs:start,grants:[grant]}}};
    const recovered={...candidate,lastVerifiedAt:new Date(start)};
    const recoveredRequest={...args,now,candidates:[recovered]};
    // A fresh authenticated proof cannot RENEW offline authorization while
    // the prior DB activation timestamp is older than the 45s proof bound.
    expect(issueRemoteLanAuthorizationLease(recoveredRequest)?.grants).toEqual([]);
    const keep=retainedRemoteLanAuthorization({
      gate,candidates:[recovered],proofs:[proof],now,
    });
    expect(keep).toEqual({issuedAtMs:start,grants:[grant]});
    expect(remoteLanAuthorizationExpiry({...gate,observedL2Diagnostic:{
      authorizationLease:keep}},grant,now)).toBe(start+REMOTE_LAN_AUTHORIZATION_TTL_MS);
    expect(retainedRemoteLanAuthorization({...{gate,candidates:[recovered],proofs:[proof]},
      now:start+600_000})).toBeNull();
    expect(retainedRemoteLanAuthorization({...{gate,candidates:[recovered],proofs:[proof]},
      now:now+30_000})?.issuedAtMs).toBe(start);
  });
  it("never retains a previous stamp for changes, revocation or unverified L2",()=>{
    const gate={gateId,tenantId,agentVersion:"gate-l2-v4",revokedAt:null,
      observedL2Diagnostic:{authorizationLease:{issuedAtMs:now-100_000,
        grants:[grant]}}};
    const base={gate,candidates:[candidate],proofs:[proof],now};
    expect(retainedRemoteLanAuthorization(base)).toEqual({
      issuedAtMs:now-100_000,grants:[grant],
    });
    const mismatch = [
      {...candidate,configurationRevision:3},
      {...candidate,macAddress:"02:ff:ff:ff:ff:ff"},
      {...candidate,tenantId:"other"},
      {...candidate,networkId:"other"},
      {...candidate,singleAppId:"other"},
      {...candidate,status:"Revoking"},
    ];
    for(const row of mismatch){
      expect(retainedRemoteLanAuthorization({...base,candidates:[row]}))
        .toBeNull();
    }
    for(const bad of [
      {...proof,macLearnedOnTunnel:false},
      {...proof,gatewayTunnelOwned:false},
      {...proof,bridgeOwned:false},
      {...proof,configurationRevision:3},
    ]){
      expect(retainedRemoteLanAuthorization({...base,proofs:[bad]})).toBeNull();
    }
    expect(retainedRemoteLanAuthorization({...base,proofs:[]})).toBeNull();
    expect(retainedRemoteLanAuthorization({...base,candidates:[
      candidate,{...candidate,attachmentId:"another",status:"Provisioning"}]}))
      .toBeNull();
    expect(retainedRemoteLanAuthorization({...base,gate:{...gate,revokedAt:new Date()}}))
      .toBeNull();
    expect(retainedRemoteLanAuthorization({...base,gate:{...gate,agentVersion:"gate-l2-v3"}}))
      .toBeNull();
    expect(retainedRemoteLanAuthorization({...base,gate:{...gate,
      observedL2Diagnostic:{authorizationLease:{issuedAtMs:now-601_000,
      grants:[grant]}}}})).toBeNull();
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
