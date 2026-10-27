import { describe, expect, it } from "vitest";
import {
  assertCreatedNodeLanLink, assertOwnedNodeLanLink, shouldDeleteNodeLanOrphan,
  nodeLanCommands, nodeLanTransportMatches, prepareNodeLanLinkForGrant,
  staticNodeLanCommands, revokeNodeLanEntries, revokeNodeLanState, sameNodeLanTarget,
  selectNodeLanTargets, sweepNodeLanOrphans,
  validateNodeLanSnapshot, type NodeLanAttachment,
  type TenantContainer,
} from "./remote-lan-node-policy";

const attachment:NodeLanAttachment = {
  attachmentId:"aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
  tenantId:"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId:"aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  gateId:"aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  networkName:"rp-network-aaaaaaaa-bbbb-4ccc-8ddd-121212121212",
  overlayCidr:"10.200.4.0/24",
  lanCidr:"192.168.50.0/24",
  gatewayOverlayIp:"10.200.4.30",
  macAddress:"02:aa:bb:cc:dd:ee",
};
const container:TenantContainer={
  Id:"a".repeat(64),
  State:{Pid:4567,Running:true},
  Config:{Labels:{
    "resourceportal.workload":"tenant",
    "resourceportal.tenant-id":attachment.tenantId,
    "resourceportal.single-app-id":attachment.singleAppId,
  }},
  NetworkSettings:{Networks:{
    [attachment.networkName]:{IPAddress:"10.200.4.15"},
  }},
};
describe("RP node-local remote LAN authorization",()=>{
  it("allows exactly one running app with exact tenant labels and network membership",()=>{
    const policy=validateNodeLanSnapshot({version:1,attachments:[attachment]});
    const targets=selectNodeLanTargets(policy,[container]);
    expect(targets).toHaveLength(1);
    expect(targets[0].pid).toBe(4567);
    expect(nodeLanCommands(targets[0],"eth1")[0][1]).toContain("10.200.4.15");
  });
  it("revokes the old node tunnel on every authorization or DHCP change, even with the same PID",()=>{
    const [original]=selectNodeLanTargets([attachment],[container]);
    const identical=selectNodeLanTargets([{...attachment}],[container])[0];
    expect(sameNodeLanTarget(original,identical)).toBe(true);
    const changedAttachments: Partial<NodeLanAttachment>[]=[
      {lanCidr:"192.168.51.0/24"},
      {gatewayOverlayIp:"10.200.4.31"},
      {macAddress:"02:aa:bb:cc:dd:ef"},
      {gateId:"aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc"},
      {overlayCidr:"10.200.4.0/25"},
      {networkName:"rp-network-aaaaaaaa-bbbb-4ccc-8ddd-343434343434"},
    ];
    for(const change of changedAttachments){
      const changed={...attachment,...change};
      const moved={...container,NetworkSettings:{Networks:{
        [changed.networkName]:{IPAddress:"10.200.4.15"},
      }}};
      const [desired]=selectNodeLanTargets([changed],[moved]);
      expect(sameNodeLanTarget(original,desired)).toBe(false);
    }
    const newOverlay={...container,NetworkSettings:{Networks:{
      [attachment.networkName]:{IPAddress:"10.200.4.16"},
    }}};
    const [newIp]=selectNodeLanTargets([attachment],[newOverlay]);
    expect(sameNodeLanTarget(original,newIp)).toBe(false);
    expect(sameNodeLanTarget(original,{...original,pid:9999})).toBe(false);
    expect(sameNodeLanTarget(original,{...original,id:"b".repeat(64)})).toBe(false);
  });
  it("denies cross-tenant containers even on identically numbered overlays",()=>{
    expect(selectNodeLanTargets([attachment],[{...container,Config:{Labels:{
      ...container.Config!.Labels,"resourceportal.tenant-id":"aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
    }}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,Config:{Labels:{
      ...container.Config!.Labels,"resourceportal.single-app-id":attachment.gateId,
    }}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,NetworkSettings:{Networks:{
      [attachment.networkName]:{IPAddress:"192.168.50.10"},
    }}}])).toEqual([]);
  });
  it("fails closed for replicated tasks with the same application identity",()=>{
    expect(()=>selectNodeLanTargets([attachment],[container,{...container,
      Id:"b".repeat(64),State:{Pid:4568,Running:true},
      NetworkSettings:{Networks:{[attachment.networkName]:{IPAddress:"10.200.4.16"}}},
    }])).toThrow(/Ambiguous/);
  });
  it("refuses route-like snapshots, duplicate attachments and spoofed MACs",()=>{
    expect(()=>validateNodeLanSnapshot({version:2,attachments:[attachment]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[attachment,attachment]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,macAddress:"00:aa:bb:cc:dd:ee"}]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,gatewayOverlayIp:"10.201.0.4"}]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,networkName:"host"}]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,lanCidr:"0.0.0.0/0"}]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,lanCidr:"192.168.50.7/24"}]})).toThrow();
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{...attachment,lanCidr:"192.168.50.0/8"}]})).toThrow();
  });
  it("isolates static source routing from the Docker overlay default route",()=>{
    const managed:NodeLanAttachment={...attachment,uplinkMode:"ManagedSharedUplink",
      addressMode:"Static",staticAddress:"192.168.50.22/24",
      staticGateway:"192.168.50.1",configurationRevision:2};
    const valid=validateNodeLanSnapshot({version:1,attachments:[managed]});
    const [target]=selectNodeLanTargets(valid,[container]);
    const command=staticNodeLanCommands(target,"rp-a-1234abcd");
    expect(command[0]).toContain("192.168.50.22/24");
    expect(command[1]).toEqual(["-4","route","replace","192.168.50.0/24","dev","rp-a-1234abcd","table","20015"]);
    expect(command[2]).toEqual(["-4","route","replace","default","via",
      "192.168.50.1","dev","rp-a-1234abcd","table","20015"]);
    expect(command[3]).toEqual(["-4","rule","add","pref","18015","from",
      "192.168.50.22/32","lookup","20015"]);
    const original=selectNodeLanTargets([attachment],[container])[0];
    expect(sameNodeLanTarget(original,target)).toBe(false);
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{
      ...managed,uplinkMode:"DedicatedUnnumbered"
    }]})).toThrow(/managed/);
    expect(()=>validateNodeLanSnapshot({version:1,attachments:[{
      ...managed,staticAddress:"10.1.2.3/24"
    }]})).toThrow();
    expect(()=>staticNodeLanCommands(target,"eth0")).toThrow();
  });
  it("rejects untrusted workload types and missing network/task provenance",()=>{
    expect(selectNodeLanTargets([attachment],[{...container,Config:{Labels:{"resourceportal.workload":"system"}}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,State:{Running:false,Pid:4567}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,Id:"short"}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,NetworkSettings:{Networks:{}}}])).toEqual([]);
  });
});

describe("node LAN GRETAP ownership before destructive cleanup", () => {
  const device = "rp-a-1234abcd";
  const alias = "rp-lan:aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
  const owned = { ifname: device, ifalias: alias, linkinfo: { info_kind: "gretap" } };
  const active = new Set([device]);

  it("adopts and revokes only a standalone app-side GRETAP with the exact grant", () => {
    expect(() => assertOwnedNodeLanLink(owned, device, attachment.attachmentId)).not.toThrow();
    expect(() => assertOwnedNodeLanLink({ ...owned, master: "br-foreign" },
      device, attachment.attachmentId)).toThrow(/bridged/);
    expect(() => assertOwnedNodeLanLink({ ...owned, master: 42 },
      device, attachment.attachmentId)).toThrow(/bridged/);
    expect(() => assertOwnedNodeLanLink({ ...owned, master: "" },
      device, attachment.attachmentId)).toThrow(/bridged/);
    expect(() => assertOwnedNodeLanLink({ ...owned, ifalias: "rp-lan:" + attachment.tenantId },
      device, attachment.attachmentId)).toThrow(/alias/);
    expect(() => assertOwnedNodeLanLink({ ...owned, linkinfo: { info_kind: "veth" } },
      device, attachment.attachmentId)).toThrow(/foreign/);
  });

  it("never selects a foreign bridge for orphan deletion, even with a valid RP alias", () => {
    expect(shouldDeleteNodeLanOrphan(owned, new Set())).toBe(true);
    expect(shouldDeleteNodeLanOrphan(owned, active)).toBe(false);
    expect(() => shouldDeleteNodeLanOrphan({ ...owned, master: "br-unrelated" },
      new Set())).toThrow(/bridged/);
    expect(() => shouldDeleteNodeLanOrphan({ ...owned, master: "rp-b-1234abcd" },
      new Set())).toThrow(/bridged/);
    expect(() => shouldDeleteNodeLanOrphan({ ...owned, linkinfo: { info_kind: "veth" } },
      new Set())).toThrow(/foreign/);
  });

  it("ignores malformed RP identities, unknown interfaces and repeat revocation", () => {
    expect(shouldDeleteNodeLanOrphan({ ...owned, ifalias: "rp-lan:invalid" }, new Set())).toBe(false);
    expect(shouldDeleteNodeLanOrphan({ ...owned, ifname: "eth0" }, new Set())).toBe(false);
    expect(shouldDeleteNodeLanOrphan({ ...owned, ifalias: undefined }, new Set())).toBe(false);
    expect(shouldDeleteNodeLanOrphan(owned, new Set([device]))).toBe(false);
  });

  it("allows cleanup of a just-created unbridged link before alias is set, but not repurposed links", () => {
    expect(() => assertCreatedNodeLanLink({ ...owned, ifalias: undefined },
      device, attachment.attachmentId)).not.toThrow();
    expect(() => assertCreatedNodeLanLink(owned, device, attachment.attachmentId)).not.toThrow();
    expect(() => assertCreatedNodeLanLink({ ...owned, ifalias: undefined, master: "br-foreign" },
      device, attachment.attachmentId)).toThrow(/bridged/);
    expect(() => assertCreatedNodeLanLink({ ...owned, ifalias: "somebody-else" },
      device, attachment.attachmentId)).toThrow(/alias/);
  });
});


describe("node LAN independent revocation", () => {
  const [first] = selectNodeLanTargets([attachment], [container]);
  const second = { ...first, id: "b".repeat(64), pid: 4568 };
  const entry = (target: typeof first) => ({
    target, dhcp: { killed: false, pid: 1234, exitCode: null },
  });

  it("revokes other stale links despite one bridged-link refusal, retaining the failed entry for retry", () => {
    const managed = new Map([
      ["bridged", entry(first)],
      ["standalone", entry(second)],
    ]);
    const attempted: string[] = [];
    expect(() => revokeNodeLanEntries(managed, new Map(), current => {
      attempted.push(current.target.id);
      if (current.target.id === first.id) throw new Error("foreign bridge");
    })).toThrow(/revocations failed/);
    expect(attempted).toEqual([first.id, second.id]);
    expect([...managed.keys()]).toEqual(["bridged"]);
    revokeNodeLanEntries(managed, new Map(), current => attempted.push("retry:" + current.target.id));
    expect(attempted.at(-1)).toBe("retry:" + first.id);
    expect(managed.size).toBe(0);
  });

  it("preserves a healthy active attachment while revoking a changed or dead one", () => {
    const managed = new Map([
      ["active", entry(first)],
      ["changed", entry(second)],
    ]);
    const desired = new Map([["active", first]]);
    const revoked: string[] = [];
    revokeNodeLanEntries(managed, desired, current => revoked.push(current.target.id));
    expect(revoked).toEqual([second.id]);
    expect([...managed.keys()]).toEqual(["active"]);
    managed.get("active")!.dhcp.killed = true;
    revokeNodeLanEntries(managed, desired, current => revoked.push(current.target.id));
    expect(revoked).toEqual([second.id, first.id]);
    expect(managed.size).toBe(0);
  });
});


describe("node LAN orphan sweep isolation", () => {
  const alias = "rp-lan:aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
  const bridged = {
    ifname: "rp-a-1234abcd", ifalias: alias,
    linkinfo: { info_kind: "gretap" }, master: "br-foreign",
  };
  const standalone = {
    ifname: "rp-a-5678abcd", ifalias: alias,
    linkinfo: { info_kind: "gretap" },
  };
  const nextNamespace = { ...standalone, ifname: "rp-a-9012abcd" };
  const namespaces = [
    { pid: 4567, active: new Set<string>() },
    { pid: 4568, active: new Set<string>() },
  ];

  it("keeps a foreign bridged orphan intact but deletes later unbridged orphans in both namespaces", () => {
    const removed: string[] = [];
    expect(() => sweepNodeLanOrphans(namespaces, pid =>
      pid === 4567 ? [bridged, standalone] : [nextNamespace],
    (pid, ifname) => removed.push(pid + ":" + ifname))).toThrow(/orphan revocations failed/);
    expect(removed).toEqual(["4567:rp-a-5678abcd", "4568:rp-a-9012abcd"]);
  });

  it("continues after namespace enumeration and individual delete failures", () => {
    const removed: string[] = [];
    expect(() => sweepNodeLanOrphans(namespaces, pid => {
      if (pid === 4567) throw new Error("namespace vanished");
      return [standalone, nextNamespace];
    }, (_pid, ifname) => {
      removed.push(ifname);
      if (ifname === standalone.ifname) throw new Error("delete denied");
    })).toThrow(/orphan revocations failed/);
    expect(removed).toEqual([standalone.ifname, nextNamespace.ifname]);
  });

  it("does not delete active, malformed or previously removed endpoints", () => {
    const removed: string[] = [];
    sweepNodeLanOrphans([{ pid: 4567, active: new Set([standalone.ifname]) }],
      () => [standalone, { ...standalone, ifname: "rp-a-abcdef12", ifalias: "bad" }],
      (_pid, ifname) => removed.push(ifname));
    expect(removed).toEqual([]);
  });
});


describe("node LAN combined pre-grant revocation", () => {
  const [target] = selectNodeLanTargets([attachment], [container]);
  const next = { ...target, id: "b".repeat(64), pid: 4568 };
  const entry = (current: typeof target, device: string) => ({
    target: current, device,
    dhcp: { killed: false, pid: 1234, exitCode: null },
  });
  const owned = {
    ifname: "rp-a-1234abcd",
    ifalias: "rp-lan:" + attachment.attachmentId,
    linkinfo: { info_kind: "gretap" },
  };

  it("continues orphan cleanup when a managed bridged revocation fails", () => {
    const managed = new Map([
      ["blocked", entry(target, "rp-a-11111111")],
      ["safe", entry(next, "rp-a-22222222")],
    ]);
    const revoked: string[] = [];
    const removed: string[] = [];
    expect(() => revokeNodeLanState(managed, new Map(), [4567, 4568],
      current => {
        revoked.push(current.device);
        if (current.device === "rp-a-11111111") throw new Error("foreign bridge");
      },
      pid => pid === 4567 ? [{ ...owned, master: "br-foreign" }] :
        [{ ...owned, ifname: "rp-a-33333333" }],
      (pid, ifname) => removed.push(pid + ":" + ifname),
    )).toThrow(/refusing new grants/);
    expect(revoked).toEqual(["rp-a-11111111", "rp-a-22222222"]);
    expect(removed).toEqual(["4568:rp-a-33333333"]);
    expect([...managed.keys()]).toEqual(["blocked"]);
  });

  it("preserves a desired pre-existing link until the post-revocation adoption", () => {
    const removed: string[] = [];
    revokeNodeLanState(new Map(), new Map([["desired", target]]), [4567],
      () => { throw new Error("unexpected detach"); },
      () => [owned, { ...owned, ifname: "rp-a-ffffffff", ifalias:
        "rp-lan:bbbbbbbb-bbbb-4ccc-8ddd-222222222222" }],
      (_pid, ifname) => removed.push(ifname));
    expect(removed).toEqual(["rp-a-ffffffff"]);
  });
});

describe("Gateway Swarm task IP rotation and persistent app GRETAP adoption", () => {
  const [dhcp] = selectNodeLanTargets([attachment], [container]);
  const staticPolicy: NodeLanAttachment = {
    ...attachment, uplinkMode: "ManagedSharedUplink", addressMode: "Static",
    staticAddress: "192.168.50.44/24", staticGateway: "192.168.50.1",
  };
  const [staticTarget] = selectNodeLanTargets([staticPolicy], [container]);
  const device = "rp-a-1234abcd";
  const link = {
    ifname: device,
    ifalias: "rp-lan:" + attachment.attachmentId,
    address: attachment.macAddress,
    linkinfo: { info_kind: "gretap", info_data: {
      local: "10.200.4.15", remote: "10.200.4.125",
    } },
  };

  it("rebuilds only owned stale peer after node-agent restart, without touching tenant eth0", () => {
    const events: string[] = [];
    const reused = prepareNodeLanLinkForGrant(dhcp, device, link,
      () => events.push("cleanup:rp-static-policy"),
      () => events.push("delete:" + device), () => true);
    expect(reused).toBe(false);
    expect(nodeLanTransportMatches(link, dhcp)).toBe(false);
    expect(events).toEqual(["cleanup:rp-static-policy", "delete:" + device]);
  });

  it("preserves already-correct Static GRETAP on restart, but rotates an old Static peer", () => {
    const correct = { ...link, linkinfo: { ...link.linkinfo, info_data: {
      local: staticTarget.tunnel.appOverlayIp,
      remote: staticTarget.tunnel.gatewayOverlayIp,
    } } };
    const changed: string[] = [];
    expect(prepareNodeLanLinkForGrant(staticTarget, device, correct,
      () => changed.push("static:cleanup"), () => changed.push("static:delete"),
      () => true)).toBe(true);
    expect(changed).toEqual([]);
    expect(prepareNodeLanLinkForGrant(staticTarget, device, link,
      () => changed.push("static:cleanup"), () => changed.push("static:delete"),
      () => true)).toBe(false);
    expect(changed).toEqual(["static:cleanup", "static:delete"]);
  });

  it("on DHCP/Static transitions, rebuilds inherited DHCP link and never adopts stale proof", () => {
    const correct = { ...link, linkinfo: { ...link.linkinfo, info_data: {
      local: dhcp.tunnel.appOverlayIp, remote: dhcp.tunnel.gatewayOverlayIp,
    } } };
    const changed: string[] = [];
    expect(prepareNodeLanLinkForGrant(dhcp, device, correct,
      () => changed.push("cleanup"), () => changed.push("delete"),
      () => true)).toBe(false);
    expect(changed).toEqual(["cleanup", "delete"]);
    const switchedStatic = { ...dhcp, attachment: staticPolicy };
    expect(sameNodeLanTarget(dhcp, switchedStatic)).toBe(false);
    // Same tunnel does not prove that the old DHCP address was replaced.
    // Without an exact Static address AND owned source route, discard it.
    expect(prepareNodeLanLinkForGrant(staticTarget, device, correct,
      () => changed.push("static:cleanup"), () => changed.push("static:delete"),
      () => false)).toBe(false);
    expect(changed).toEqual(["cleanup","delete","static:cleanup","static:delete"]);
  });


  it("refuses Static adoption when a previous DHCP address or partial route remains", () => {
    const correct = { ...link, linkinfo: { ...link.linkinfo, info_data: {
      local: staticTarget.tunnel.appOverlayIp,
      remote: staticTarget.tunnel.gatewayOverlayIp,
    } } };
    const operations: string[] = [];
    const checked = () => {
      operations.push("verify-static-address-and-route");
      return false; // Other IPv4 address or missing routing table.
    };
    expect(prepareNodeLanLinkForGrant(staticTarget, device, correct,
      () => operations.push("cleanup-owned-policy"),
      () => operations.push("delete-owned-link"), checked)).toBe(false);
    expect(operations).toEqual([
      "verify-static-address-and-route", "cleanup-owned-policy", "delete-owned-link",
    ]);
  });

  it("never removes foreign, bridged or wrong-alias links, even when remote peer is stale", () => {
    const cases = [
      { ...link, ifalias: "rp-lan:" + attachment.gateId },
      { ...link, master: "br-foreign" },
      { ...link, linkinfo: { ...link.linkinfo, info_kind: "veth" } },
      { ...link, ifname: "eth0" },
    ];
    for (const alien of cases) {
      const events: string[] = [];
      expect(() => prepareNodeLanLinkForGrant(dhcp, device, alien,
        () => events.push("cleanup"), () => events.push("delete"),
        () => true)).toThrow(/foreign|bridged|alias/);
      expect(events).toEqual([]);
    }
  });

  it("fails closed on partial Static cleanup and cannot erase the interface", () => {
    const events: string[] = [];
    expect(() => prepareNodeLanLinkForGrant(staticTarget, device, link, () => {
      events.push("cleanup");
      throw new Error("foreign source routing owner");
    }, () => events.push("delete"), () => false)).toThrow(/foreign source/);
    expect(events).toEqual(["cleanup"]);
  });

  it("rejects wrong app-local, remote or MAC in transport evidence", () => {
    const correct = { ...link, linkinfo: { ...link.linkinfo, info_data: {
      local: dhcp.tunnel.appOverlayIp, remote: dhcp.tunnel.gatewayOverlayIp,
    } } };
    expect(nodeLanTransportMatches(correct, dhcp)).toBe(true);
    expect(nodeLanTransportMatches({ ...correct, address: "02:aa:aa:aa:aa:aa" }, dhcp)).toBe(false);
    expect(nodeLanTransportMatches({ ...correct, linkinfo: { ...correct.linkinfo,
      info_data: { ...correct.linkinfo.info_data, local: "10.200.4.99" } } }, dhcp)).toBe(false);
    expect(nodeLanTransportMatches({ ...correct, linkinfo: { ...correct.linkinfo,
      info_data: { ...correct.linkinfo.info_data, remote: "10.200.4.125" } } }, dhcp)).toBe(false);
  });
});
