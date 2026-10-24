import { useMemo, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button, Card, NetworkIcon, ServerIcon, StatusBadge, statusTone } from "../components/design-system";

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

type GraphNodeData = { label: string; detail: string; status?: string; category: "application" | "network"; group?: string };
type GraphNode = Node<GraphNodeData, "resource">;

function ResourceNode({ data, isConnectable }: NodeProps<GraphNode>) {
  const isNetwork = data.category === "network";
  return (
    <div className="w-[260px] overflow-hidden rounded-xl border border-[#D7E0EC] bg-white shadow-[0_4px_18px_rgba(31,50,81,0.08)] transition-shadow hover:shadow-[0_8px_24px_rgba(31,50,81,0.14)]">
      {!isNetwork ? <Handle type="source" position={Position.Right} isConnectable={isConnectable} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4479CA]" /> :
        <Handle type="target" position={Position.Left} isConnectable={isConnectable} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-[#4479CA]" />}
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#DFE8F5] bg-[#F0F5FC] text-[#406DAB]">
          {isNetwork ? <NetworkIcon /> : <ServerIcon />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#718096]">{isNetwork ? "Private Network" : data.group || "Application"}</div>
          <div className="truncate text-sm font-semibold text-[#26364B]" title={data.label}>{data.label}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-[#718096]" title={data.detail}>{data.detail}</div>
        </div>
      </div>
      {data.status ? <div className="border-t border-[#E6ECF4] bg-[#FAFCFF] px-4 py-2"><StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge></div> : null}
    </div>
  );
}

const nodeTypes = { resource: ResourceNode };

export function buildTopologyGraph(topology: Topology) {
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  let appIndex = 0;
  for (const group of topology.appGroups) {
    for (const app of group.singleApps) {
      nodes.push({
        id: "app:" + app.id, position: { x: 40, y: appIndex * 152 + 30 },
        data: { label: app.name, detail: app.image || "Application service", group: group.name,
          status: app.effectiveRuntimeState || app.runtimeState, category: "application" }, type: "resource",
      });
      for (const link of app.networkAttachments ?? []) {
        if (!topology.networks.some(network => network.id === link.networkId)) continue;
        edges.push({
          id: "attachment:" + link.id, source: "app:" + app.id, target: "network:" + link.networkId,
          label: link.address, data: { attachmentId: link.id, networkId: link.networkId },
          type: "smoothstep", animated: false,
          style: { stroke: "#6890C6", strokeWidth: 2 },
          labelStyle: { fill: "#35577E", fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: "#FFFFFF", fillOpacity: 0.96, stroke: "#D7E0EC", strokeWidth: 1 },
          labelBgBorderRadius: 6,
        });
      }
      appIndex += 1;
    }
  }
  topology.networks.forEach((network, index) => {
    nodes.push({
      id: "network:" + network.id, position: { x: 520, y: index * 164 + 30 },
      data: { label: network.name, detail: network.cidr, status: network.status, category: "network" },
      type: "resource",
    });
  });
  return { nodes, edges };
}

export function TenantNetworkingGraph({
  topology, working = false, onConnect, onDisconnect,
}: {
  topology: Topology; working?: boolean;
  onConnect?: (connection: Connection) => void;
  onDisconnect?: (edge: Edge) => void;
}) {
  const graph = useMemo(() => buildTopologyGraph(topology), [topology]);
  const [selected, setSelected] = useState<string>();
  const selectedEdge = graph.edges.find(edge => edge.id === selected);
  const hasNodes = graph.nodes.length > 0;
  return (
    <Card className="mt-5 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E6ECF4] px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-[#26364B]">Application topology</h2>
          <p className="mt-1 text-sm text-[#718096]">Visualize application connections to private Networks. LAN Attachments are managed separately.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge tone="neutral">{graph.nodes.filter(node => node.id.startsWith("app:")).length} applications</StatusBadge>
          <StatusBadge tone="info">{topology.networks.length} Networks</StatusBadge>
          <StatusBadge tone="neutral">{graph.edges.length} links</StatusBadge>
        </div>
      </div>
      {hasNodes ? (
        <div className="relative h-[440px] w-full bg-[#FAFCFF] sm:h-[520px]">
          <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes}
            fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.25} maxZoom={1.6}
            nodesDraggable={false} nodesConnectable={!working} edgesReconnectable={false}
            onConnect={connection => onConnect?.(connection)}
            onPaneClick={() => setSelected(undefined)}
            onEdgeClick={(_event, edge) => setSelected(edge.id)}
            defaultEdgeOptions={{ interactionWidth: 20 }}
            proOptions={{ hideAttribution: true }}>
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="#DCE5F0" />
            <Controls className="!overflow-hidden !rounded-lg !border !border-[#D7E0EC] !bg-white !shadow-sm" showInteractive={false} />
            <MiniMap pannable zoomable className="!rounded-lg !border !border-[#D7E0EC] !bg-white"
              nodeColor={node => node.id.startsWith("network:") ? "#739CD3" : "#B5C8DF"} />
          </ReactFlow>
        </div>
      ) : <div className="flex min-h-56 flex-col items-center justify-center gap-2 bg-[#FAFCFF] px-6 text-center">
        <NetworkIcon /><p className="text-sm font-semibold text-[#26364B]">No topology to display</p>
        <p className="text-sm text-[#718096]">Create a Network and attach an application to visualize its connections.</p>
      </div>}
      {selectedEdge ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E6ECF4] bg-white px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="info">Application Network</StatusBadge>
            <span className="font-mono text-xs text-[#52657D]">{selectedEdge.label}</span>
          </div>
          {onDisconnect ? <Button size="sm" disabled={working} onClick={() => onDisconnect(selectedEdge)}>Disconnect application</Button> : null}
        </div>
      ) : <p className="border-t border-[#E6ECF4] px-5 py-2.5 text-xs text-[#718096]">Select a connection to view its address and available actions. Drag between handles to attach an application.</p>}
    </Card>
  );
}
