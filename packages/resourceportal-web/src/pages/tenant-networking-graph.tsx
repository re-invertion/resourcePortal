import { useMemo, useState } from "react";
import { Background, Controls, MiniMap, ReactFlow, type Connection, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, Card, StatusBadge } from "../components/design-system";

export type ApplicationAttachment={id:string;networkId:string;address:string};
export type Application={
  id:string;name:string;image?:string;runtimeState?:string;effectiveRuntimeState?:string;
  networkAttachments:ApplicationAttachment[];
  httpEndpoints?:Array<{id:string;protocolMode:string;domains:Array<{hostname:string;tlsEnabled:boolean;dnsStatus?:string}>}>;
};
export type AppGroup={
  id:string;name:string;hasPendingChanges:boolean;effectiveRuntimeState?:string;
  currentDeploymentVersion?:number|null; appGroupNetwork?:{name:string}|null;
  singleApps:Application[];
};
export type NetworkAttachment={
  id:string;address:string;singleAppId:string;
  singleApp:{id:string;name:string;appGroup:{id:string;name:string;hasPendingChanges:boolean}};
};
export type NetworkResource={
  id:string;name:string;description?:string|null;cidr:string;overlayCidr:string;
  status:string;revision:number;lastObservedAt?:string|null;lastError?:string|null;
  attachments:NetworkAttachment[];
};
export type GateResource={
  id:string;name:string;description?:string|null;status:string;configRevision:number;
  agentVersion?:string|null;serverListenPort?:number|null;lastSeenAt?:string|null;
  lastError?:string|null;revokedAt?:string|null;
};
export type Topology={networks:NetworkResource[];gates:GateResource[];appGroups:AppGroup[]};

export function buildTopologyGraph(topology:Topology) {
  const nodes:Node[]=[];
  const edges:Edge[]=[];
  let appIndex=0;
  for(const group of topology.appGroups) {
    for(const app of group.singleApps) {
      nodes.push({
        id:"app:"+app.id, position:{x:30,y:appIndex*125+25},
        data:{label:group.name+" / "+app.name}, type:"default",
        style:{width:250,border:"1px solid #C5D1E3",borderRadius:10,padding:10},
      });
      for(const link of app.networkAttachments ?? []) {
        if(!topology.networks.some(n=>n.id===link.networkId))continue;
        edges.push({
          id:"attachment:"+link.id, source:"app:"+app.id,target:"network:"+link.networkId,
          label:link.address, data:{attachmentId:link.id,networkId:link.networkId},
          type:"smoothstep",animated:false,
        });
      }
      appIndex+=1;
    }
  }
  topology.networks.forEach((network,i)=>{
    nodes.push({
      id:"network:"+network.id,position:{x:450,y:i*145+25},
      data:{label:network.name+" · "+network.cidr},type:"default",
      style:{width:250,border:"1px solid #A5BADA",borderRadius:10,padding:12},
    });
  });
  return {nodes,edges};
}

export function TenantNetworkingGraph({
  topology,working=false,onConnect,onDisconnect,
}:{
  topology:Topology;working?:boolean;
  onConnect?:(connection:Connection)=>void;
  onDisconnect?:(edge:Edge)=>void;
}) {
  const graph=useMemo(()=>buildTopologyGraph(topology),[topology]);
  const [selected,setSelected]=useState<Edge>();
  const selectedEdge=graph.edges.find(edge=>edge.id===selected?.id);
  return (
    <Card className="mt-5 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold">Application Networks</h2>
        <p className="text-sm text-[#718096]">
          Only application-to-Network links appear here. Remote LAN access is managed
          separately per application in LAN Attachments.
        </p>
      </div>
      <div style={{width:"100%",height:Math.max(360,Math.max(graph.nodes.length,2)*62)}}>
        <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView
          nodesDraggable={false} nodesConnectable={!working}
          edgesReconnectable={false}
          onConnect={connection=>onConnect?.(connection)}
          onEdgeClick={(_event,edge)=>setSelected(edge)}
        >
          <Background/><Controls/><MiniMap/>
        </ReactFlow>
      </div>
      {selectedEdge ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
          <StatusBadge tone="info">Application Network</StatusBadge>
          <span className="text-sm">{selectedEdge.label}</span>
          {onDisconnect?<Button size="sm" disabled={working}
            onClick={()=>onDisconnect(selectedEdge)}>Disconnect application</Button>:null}
        </div>
      ):null}
    </Card>
  );
}
