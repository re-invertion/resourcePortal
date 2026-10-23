import { describe, expect, it } from "vitest";
import {
  nodeLanCommands, sameNodeLanTarget, selectNodeLanTargets, validateNodeLanSnapshot, type NodeLanAttachment,
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
  it("rejects untrusted workload types and missing network/task provenance",()=>{
    expect(selectNodeLanTargets([attachment],[{...container,Config:{Labels:{"resourceportal.workload":"system"}}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,State:{Running:false,Pid:4567}}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,Id:"short"}])).toEqual([]);
    expect(selectNodeLanTargets([attachment],[{...container,NetworkSettings:{Networks:{}}}])).toEqual([]);
  });
});
