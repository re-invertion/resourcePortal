import { expect, it } from "vitest";
import { buildTopologyGraph, type Topology } from "./tenant-networking-graph";

it("shows only actual app-to-Network links and excludes Gate site-wide routing",()=>{
  const topology:Topology={
    networks:[{
      id:"network-1",name:"backend",status:"Ready",revision:2,cidr:"10.240.1.0/24",
      overlayCidr:"10.200.1.0/24",attachments:[],
    }],
    gates:[{id:"gate-1",name:"Remote RP Gate",status:"Ready",configRevision:1}],
    appGroups:[{
      id:"group-1",name:"showcase",hasPendingChanges:false,
      singleApps:[{id:"app-1",name:"web",runtimeState:"Running",
        networkAttachments:[{id:"attachment-1",networkId:"network-1",address:"10.240.1.20"}]}],
    }],
  };
  const graph=buildTopologyGraph(topology);
  expect(graph.nodes.map(node=>node.id)).toEqual(["app:app-1","network:network-1"]);
  expect(graph.edges).toEqual([expect.objectContaining({
    id:"attachment:attachment-1",source:"app:app-1",target:"network:network-1",
    data:{attachmentId:"attachment-1",networkId:"network-1"},
  })]);
  expect(JSON.stringify(graph)).not.toMatch(/site-vpn|BGP|gate:gate-1/i);
});
