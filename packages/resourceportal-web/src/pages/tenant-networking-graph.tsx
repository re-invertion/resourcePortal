import { useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Button,
  ConfirmActionButton,
  GridIcon,
  NetworkIcon,
  SearchField,
  Select,
  ServerIcon,
  StatusBadge,
  cx,
  statusTone,
} from "../components/design-system";
import { formatDate } from "../hooks/use-api";

export type ApplicationAttachment = {
  id: string;
  networkId: string;
  address: string;
};

export type Application = {
  id: string;
  name: string;
  image?: string;
  runtimeState?: string;
  networkAttachments: ApplicationAttachment[];
};

export type AppGroup = {
  id: string;
  name: string;
  hasPendingChanges: boolean;
  currentDeploymentVersion?: number | null;
  appGroupNetwork?: {
    name: string;
  } | null;
  singleApps: Application[];
};

export type NetworkAttachment = {
  id: string;
  address: string;
  singleAppId: string;
  singleApp: {
    id: string;
    name: string;
    appGroup: {
      id: string;
      name: string;
      hasPendingChanges: boolean;
    };
  };
};

export type NetworkResource = {
  id: string;
  name: string;
  description?: string | null;
  cidr: string;
  overlayCidr: string;
  status: string;
  revision: number;
  lastObservedAt?: string | null;
  lastError?: string | null;
  attachments: NetworkAttachment[];
  gateAttachments: Array<{
    id: string;
    status: string;
    enabled: boolean;
    gate: {
      id: string;
      name: string;
      status: string;
      lastSeenAt?: string | null;
    };
  }>;
};

export type GateNetworkLink = {
  id: string;
  status: string;
  enabled: boolean;
  lastError?: string | null;
  network: {
    id: string;
    name: string;
    cidr: string;
  };
};

export type GateResource = {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  configRevision: number;
  serverListenPort?: number | null;
  clientTunnelAddress?: string | null;
  serverTunnelAddress?: string | null;
  lanAddresses: string[];
  lanCidrs: string[];
  agentVersion?: string | null;
  lastSeenAt?: string | null;
  lastError?: string | null;
  revokedAt?: string | null;
  networks: GateNetworkLink[];
};

export type Topology = {
  networks: NetworkResource[];
  gates: GateResource[];
  appGroups: AppGroup[];
};

type AppGroupNodeData = {
  kind: "app-group";
  appGroupId: string;
  label: string;
  internalNetworkName?: string;
  deploymentVersion?: number | null;
  pending: boolean;
  appCount: number;
};

type ApplicationNodeData = {
  kind: "application";
  appId: string;
  appGroupId: string;
  label: string;
  groupName: string;
  runtimeState?: string;
  pending: boolean;
  attachmentCount: number;
};

type NetworkNodeData = {
  kind: "network";
  networkId: string;
  label: string;
  cidr: string;
  overlayCidr: string;
  revision: number;
  status: string;
  attachmentCount: number;
  gateCount: number;
  lastError?: string | null;
};

type GateNodeData = {
  kind: "gate";
  gateId: string;
  label: string;
  status: string;
  revision: number;
  lanAddress?: string;
  lanCidrs: string[];
  networkCount: number;
  lastSeenAt?: string | null;
  lastError?: string | null;
};

export type TopologyNodeData =
  | AppGroupNodeData
  | ApplicationNodeData
  | NetworkNodeData
  | GateNodeData;

export type TopologyEdgeData =
  | {
      kind: "application-network";
      networkId: string;
      attachmentId: string;
      revision: number;
      address: string;
      label: string;
      status: string;
    }
  | {
      kind: "gate-network";
      gateId: string;
      networkId: string;
      revision: number;
      label: string;
      status: string;
      lastError?: string | null;
    };

export type TopologyGraphFilters = {
  query: string;
  focusNetworkId: string;
  showApplications: boolean;
  showGates: boolean;
  status: "all" | "attention";
};

const FRAME_WIDTH = 310;
const FRAME_HEADER_HEIGHT = 66;
const FRAME_PADDING_X = 18;
const FRAME_PADDING_BOTTOM = 18;
const APP_NODE_WIDTH = FRAME_WIDTH - FRAME_PADDING_X * 2;
const APP_NODE_HEIGHT = 72;
const APP_NODE_GAP = 12;
const NETWORK_WIDTH = 292;
const NETWORK_HEIGHT = 126;
const GATE_WIDTH = 270;
const GATE_HEIGHT = 108;
const NETWORK_X = 650;
const GATE_X = 1080;
const FRAME_X = 40;
const NETWORK_VERTICAL_GAP = 205;
const GROUP_VERTICAL_GAP = 56;
const GATE_VERTICAL_GAP = 42;

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isHealthyStatus(value: unknown) {
  const state = normalized(value).replace(/[ _-]/g, "");
  return [
    "healthy",
    "running",
    "active",
    "ready",
    "succeeded",
    "success",
    "verified",
    "valid",
    "insync",
    "available",
    "completed",
  ].some((candidate) => state.includes(candidate));
}

function textMatches(query: string, ...values: unknown[]) {
  if (!query) return true;
  return values.some((value) => normalized(value).includes(query));
}

function average(values: number[], fallback: number) {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function frameHeight(appCount: number) {
  return (
    FRAME_HEADER_HEIGHT +
    FRAME_PADDING_BOTTOM +
    appCount * APP_NODE_HEIGHT +
    Math.max(0, appCount - 1) * APP_NODE_GAP
  );
}

function connectedNetworkIdsForGroup(group: AppGroup) {
  return new Set(
    group.singleApps.flatMap((app) =>
      app.networkAttachments.map((attachment) => attachment.networkId),
    ),
  );
}

function appMatches(
  app: Application,
  group: AppGroup,
  topology: Topology,
  query: string,
) {
  if (!query) return true;
  if (textMatches(query, app.name, app.image, group.name, group.appGroupNetwork?.name)) {
    return true;
  }
  return app.networkAttachments.some((attachment) => {
    const network = topology.networks.find((item) => item.id === attachment.networkId);
    return textMatches(query, attachment.address, network?.name, network?.cidr);
  });
}

function gateMatches(gate: GateResource, query: string) {
  if (!query) return true;
  return textMatches(
    query,
    gate.name,
    gate.description,
    gate.status,
    gate.agentVersion,
    gate.lanAddresses.join(" "),
    gate.lanCidrs.join(" "),
    ...gate.networks.flatMap((link) => [link.network.name, link.network.cidr]),
  );
}

function networkMatches(network: NetworkResource, topology: Topology, query: string) {
  if (!query) return true;
  if (
    textMatches(
      query,
      network.name,
      network.description,
      network.cidr,
      network.overlayCidr,
      network.status,
      network.lastError,
    )
  ) {
    return true;
  }
  const matchingApp = network.attachments.some((attachment) =>
    textMatches(
      query,
      attachment.address,
      attachment.singleApp.name,
      attachment.singleApp.appGroup.name,
    ),
  );
  if (matchingApp) return true;
  return network.gateAttachments.some((attachment) =>
    textMatches(query, attachment.gate.name, attachment.gate.status),
  );
}

function attentionApp(app: Application, group: AppGroup) {
  return group.hasPendingChanges || !isHealthyStatus(app.runtimeState);
}

function attentionGate(gate: GateResource) {
  return Boolean(gate.revokedAt || gate.lastError) || !isHealthyStatus(gate.status);
}

function attentionNetwork(network: NetworkResource) {
  return Boolean(network.lastError) || !isHealthyStatus(network.status);
}

function nodeData(props: NodeProps) {
  return props.data as unknown as TopologyNodeData;
}

function AppGroupFrameNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "app-group") return null;
  return (
    <section
      className={cx(
        "h-full w-full overflow-hidden rounded-2xl border bg-[#F8FAFD]/95 shadow-[0_8px_28px_rgba(36,74,120,.06)] transition",
        props.selected ? "border-[#1769E0] ring-2 ring-[#1769E0]/15" : "border-[#C9D6E7]",
      )}
      aria-label={`App Group ${data.label}`}
    >
      <header className="flex h-[66px] items-center gap-3 border-b border-[#DCE4EF] bg-white/80 px-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EEF2F7] text-[#526070]">
          <GridIcon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-[13px] text-[#172033]">{data.label}</strong>
            {data.pending ? <StatusBadge tone="warning">Pending</StatusBadge> : null}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[#718096]">
            {data.internalNetworkName
              ? `${data.appCount} apps · internal overlay`
              : `${data.appCount} apps · not deployed`}
          </p>
        </div>
      </header>
    </section>
  );
}

function ApplicationNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "application") return null;
  return (
    <div
      className={cx(
        "flex h-[72px] w-full items-center gap-3 rounded-xl border bg-white px-3.5 shadow-[0_4px_14px_rgba(36,74,120,.07)] transition",
        props.selected ? "border-[#1769E0] ring-2 ring-[#1769E0]/15" : "border-[#D5DEEA]",
      )}
      aria-label={`Application ${data.label}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">
        <GridIcon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-[13px] text-[#172033]">{data.label}</strong>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className={cx(
            "h-2 w-2 shrink-0 rounded-full",
            isHealthyStatus(data.runtimeState) ? "bg-[#20A464]" : "bg-[#D18B00]",
          )} />
          <span className="truncate text-[11px] text-[#718096]">
            {data.runtimeState || "Unknown"} · {data.attachmentCount} network{data.attachmentCount === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <Handle
        id="network-out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-white !bg-[#1769E0]"
      />
    </div>
  );
}

function NetworkNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "network") return null;
  return (
    <article
      className={cx(
        "relative h-[126px] w-[292px] rounded-2xl border-2 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(23,105,224,.10)] transition",
        props.selected ? "border-[#1769E0] ring-4 ring-[#1769E0]/10" : "border-[#8BB7ED]",
      )}
      aria-label={`Network ${data.label}`}
    >
      <Handle
        id="applications"
        type="target"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#1769E0]"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#DDEEFF] text-[#1769E0]">
          <NetworkIcon size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <strong className="truncate text-[14px] text-[#172033]">{data.label}</strong>
            <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
          </div>
          <code className="mt-1 block truncate text-[11px] text-[#526070]">{data.cidr}</code>
          <p className="mt-2 text-[11px] text-[#718096]">
            {data.attachmentCount} apps · {data.gateCount} gates · rev {data.revision}
          </p>
        </div>
      </div>
      <Handle
        id="gates"
        type="target"
        position={Position.Right}
        className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#137A4A]"
      />
    </article>
  );
}

function GateNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "gate") return null;
  return (
    <article
      className={cx(
        "relative h-[108px] w-[270px] rounded-2xl border bg-white px-4 py-3.5 shadow-[0_8px_24px_rgba(19,122,74,.08)] transition",
        props.selected ? "border-[#137A4A] ring-4 ring-[#137A4A]/10" : "border-[#B8D9C8]",
      )}
      aria-label={`ResourcePortalGate ${data.label}`}
    >
      <Handle
        id="network-in"
        type="source"
        position={Position.Left}
        className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#137A4A]"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#E2F5EB] text-[#137A4A]">
          <ServerIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <strong className="truncate text-[13px] text-[#172033]">{data.label}</strong>
            <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
          </div>
          <span className="mt-1 block truncate text-[11px] text-[#718096]">
            {data.lanAddress ? `LAN ${data.lanAddress}` : "Awaiting LAN address"}
          </span>
          <span className="mt-2 block text-[11px] text-[#718096]">
            {data.networkCount} network{data.networkCount === 1 ? "" : "s"} · rev {data.revision}
          </span>
        </div>
      </div>
    </article>
  );
}

const nodeTypes = {
  appGroup: AppGroupFrameNode,
  application: ApplicationNode,
  network: NetworkNode,
  gate: GateNode,
};

function RelationshipEdge(props: EdgeProps) {
  const data = props.data as TopologyEdgeData | undefined;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 18,
  });
  const gate = data?.kind === "gate-network";
  const stroke = props.selected ? (gate ? "#137A4A" : "#1769E0") : gate ? "#71AE8D" : "#8AAFD9";
  return (
    <>
      <BaseEdge
        id={props.id}
        path={edgePath}
        markerEnd={props.markerEnd}
        style={{
          stroke,
          strokeWidth: props.selected ? 3 : 2,
          opacity: props.selected ? 1 : 0.88,
        }}
      />
      {data?.label ? (
        <EdgeLabelRenderer>
          <div
            className={cx(
              "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-white/95 px-2 py-1 text-[10px] font-medium shadow-sm",
              gate ? "border-[#C9EBD9] text-[#137A4A]" : "border-[#CADDF7] text-[#135FBB]",
              props.selected && "ring-2 ring-[#1769E0]/10",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const edgeTypes = {
  relationship: RelationshipEdge,
};

function visibleTopology(topology: Topology, filters: TopologyGraphFilters) {
  const query = normalized(filters.query);
  const focusNetworkId = filters.focusNetworkId || undefined;

  const focusNetwork = focusNetworkId
    ? topology.networks.find((network) => network.id === focusNetworkId)
    : undefined;
  const focusAppIds = new Set(
    focusNetwork?.attachments.map((attachment) => attachment.singleAppId) ?? [],
  );
  const focusGateIds = new Set(
    focusNetwork?.gateAttachments.map((attachment) => attachment.gate.id) ?? [],
  );

  const groups = topology.appGroups
    .map((group) => {
      if (!filters.showApplications) return { ...group, singleApps: [] };
      const directGroupMatch = textMatches(
        query,
        group.name,
        group.appGroupNetwork?.name,
      );
      const singleApps = group.singleApps.filter((app) => {
        if (focusNetworkId && !focusAppIds.has(app.id)) return false;
        if (filters.status === "attention" && !attentionApp(app, group)) return false;
        if (!query) return true;
        if (directGroupMatch) return true;
        if (appMatches(app, group, topology, query)) return true;
        return app.networkAttachments.some((attachment) => {
          const network = topology.networks.find((item) => item.id === attachment.networkId);
          return network ? networkMatches(network, topology, query) : false;
        });
      });
      return { ...group, singleApps };
    })
    .filter((group) => group.singleApps.length > 0);

  const visibleAppIds = new Set(groups.flatMap((group) => group.singleApps.map((app) => app.id)));

  const gates = filters.showGates
    ? topology.gates.filter((gate) => {
        if (focusNetworkId && !focusGateIds.has(gate.id)) return false;
        if (filters.status === "attention" && !attentionGate(gate)) return false;
        if (!query) return true;
        if (gateMatches(gate, query)) return true;
        return gate.networks.some((link) => {
          const network = topology.networks.find((item) => item.id === link.network.id);
          return network ? networkMatches(network, topology, query) : false;
        });
      })
    : [];

  const visibleGateIds = new Set(gates.map((gate) => gate.id));

  const networks = topology.networks.filter((network) => {
    if (focusNetworkId) return network.id === focusNetworkId;

    const hasVisibleApp = network.attachments.some((attachment) =>
      visibleAppIds.has(attachment.singleAppId),
    );
    const hasVisibleGate = network.gateAttachments.some((attachment) =>
      visibleGateIds.has(attachment.gate.id),
    );

    if (filters.status === "attention") {
      if (attentionNetwork(network)) return true;
      if (hasVisibleApp || hasVisibleGate) return true;
      return false;
    }

    if (!query) return true;
    return networkMatches(network, topology, query) || hasVisibleApp || hasVisibleGate;
  });

  const visibleNetworkIds = new Set(networks.map((network) => network.id));

  return {
    groups,
    networks,
    gates,
    visibleAppIds,
    visibleGateIds,
    visibleNetworkIds,
  };
}

export function buildTopologyGraph(
  topology: Topology,
  filters: TopologyGraphFilters,
): { nodes: Node[]; edges: Edge[] } {
  const view = visibleTopology(topology, filters);
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const networkY = new Map<string, number>();
  view.networks.forEach((network, index) => {
    networkY.set(network.id, 80 + index * NETWORK_VERTICAL_GAP);
  });

  const groupLayout = view.groups
    .map((group) => {
      const relatedNetworkY = Array.from(connectedNetworkIdsForGroup(group))
        .filter((networkId) => view.visibleNetworkIds.has(networkId))
        .map((networkId) => networkY.get(networkId))
        .filter((value): value is number => typeof value === "number");
      return {
        group,
        desiredY: average(
          relatedNetworkY,
          80 + view.networks.length * NETWORK_VERTICAL_GAP,
        ),
        height: frameHeight(group.singleApps.length),
      };
    })
    .sort(
      (a, b) =>
        a.desiredY - b.desiredY ||
        a.group.name.localeCompare(b.group.name),
    );

  let nextGroupY = 40;
  for (const item of groupLayout) {
    const groupY = Math.max(nextGroupY, item.desiredY - item.height / 2);
    nextGroupY = groupY + item.height + GROUP_VERTICAL_GAP;

    nodes.push({
      id: `app-group:${item.group.id}`,
      type: "appGroup",
      position: { x: FRAME_X, y: groupY },
      data: {
        kind: "app-group",
        appGroupId: item.group.id,
        label: item.group.name,
        internalNetworkName: item.group.appGroupNetwork?.name,
        deploymentVersion: item.group.currentDeploymentVersion,
        pending: item.group.hasPendingChanges,
        appCount: item.group.singleApps.length,
      } satisfies AppGroupNodeData,
      style: { width: FRAME_WIDTH, height: item.height },
      ariaLabel: `App Group ${item.group.name}`,
    });

    item.group.singleApps.forEach((app, appIndex) => {
      nodes.push({
        id: `app:${app.id}`,
        type: "application",
        parentId: `app-group:${item.group.id}`,
        extent: "parent",
        position: {
          x: FRAME_PADDING_X,
          y: FRAME_HEADER_HEIGHT + appIndex * (APP_NODE_HEIGHT + APP_NODE_GAP),
        },
        data: {
          kind: "application",
          appId: app.id,
          appGroupId: item.group.id,
          label: app.name,
          groupName: item.group.name,
          runtimeState: app.runtimeState,
          pending: item.group.hasPendingChanges,
          attachmentCount: app.networkAttachments.length,
        } satisfies ApplicationNodeData,
        style: { width: APP_NODE_WIDTH, height: APP_NODE_HEIGHT },
        ariaLabel: `Application ${app.name} in ${item.group.name}`,
      });
    });
  }

  view.networks.forEach((network) => {
    nodes.push({
      id: `network:${network.id}`,
      type: "network",
      position: { x: NETWORK_X, y: networkY.get(network.id) ?? 80 },
      data: {
        kind: "network",
        networkId: network.id,
        label: network.name,
        cidr: network.cidr,
        overlayCidr: network.overlayCidr,
        revision: network.revision,
        status: network.status,
        attachmentCount: network.attachments.length,
        gateCount: network.gateAttachments.length,
        lastError: network.lastError,
      } satisfies NetworkNodeData,
      style: { width: NETWORK_WIDTH, height: NETWORK_HEIGHT },
      ariaLabel: `Network ${network.name}, ${network.cidr}`,
    });
  });

  const gateLayout = view.gates
    .map((gate) => {
      const relatedNetworkY = gate.networks
        .filter((link) => view.visibleNetworkIds.has(link.network.id))
        .map((link) => networkY.get(link.network.id))
        .filter((value): value is number => typeof value === "number");
      return {
        gate,
        desiredY: average(
          relatedNetworkY,
          80 + view.networks.length * NETWORK_VERTICAL_GAP,
        ),
      };
    })
    .sort(
      (a, b) =>
        a.desiredY - b.desiredY ||
        a.gate.name.localeCompare(b.gate.name),
    );

  let nextGateY = 50;
  for (const item of gateLayout) {
    const gateY = Math.max(nextGateY, item.desiredY);
    nextGateY = gateY + GATE_HEIGHT + GATE_VERTICAL_GAP;
    nodes.push({
      id: `gate:${item.gate.id}`,
      type: "gate",
      position: { x: GATE_X, y: gateY },
      data: {
        kind: "gate",
        gateId: item.gate.id,
        label: item.gate.name,
        status: item.gate.status,
        revision: item.gate.configRevision,
        lanAddress: item.gate.lanAddresses?.[0],
        lanCidrs: item.gate.lanCidrs ?? [],
        networkCount: item.gate.networks?.length ?? 0,
        lastSeenAt: item.gate.lastSeenAt,
        lastError: item.gate.lastError,
      } satisfies GateNodeData,
      style: { width: GATE_WIDTH, height: GATE_HEIGHT },
      ariaLabel: `ResourcePortalGate ${item.gate.name}`,
    });
  }

  for (const network of view.networks) {
    for (const attachment of network.attachments) {
      if (!view.visibleAppIds.has(attachment.singleAppId)) continue;
      edges.push({
        id: `app-edge:${attachment.id}`,
        source: `app:${attachment.singleAppId}`,
        sourceHandle: "network-out",
        target: `network:${network.id}`,
        targetHandle: "applications",
        type: "relationship",
        data: {
          kind: "application-network",
          networkId: network.id,
          attachmentId: attachment.id,
          revision: network.revision,
          address: attachment.address,
          label: attachment.address,
          status: network.status,
        } satisfies TopologyEdgeData,
        ariaLabel: `${attachment.singleApp.name} connected to ${network.name} as ${attachment.address}`,
      });
    }
  }

  for (const gate of view.gates) {
    for (const link of gate.networks ?? []) {
      if (!view.visibleNetworkIds.has(link.network.id)) continue;
      edges.push({
        id: `gate-edge:${gate.id}:${link.network.id}`,
        source: `gate:${gate.id}`,
        sourceHandle: "network-in",
        target: `network:${link.network.id}`,
        targetHandle: "gates",
        type: "relationship",
        animated: gate.status === "Ready" && link.status === "Ready",
        data: {
          kind: "gate-network",
          gateId: gate.id,
          networkId: link.network.id,
          revision: gate.configRevision,
          label: "WireGuard route",
          status: link.status,
          lastError: link.lastError,
        } satisfies TopologyEdgeData,
        ariaLabel: `${gate.name} routes ${link.network.name} through WireGuard`,
      });
    }
  }

  return { nodes, edges };
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-b border-[#EDF1F6] py-2.5 last:border-b-0">
      <dt className="text-[11px] font-medium uppercase tracking-[.03em] text-[#8A96A8]">{label}</dt>
      <dd className="min-w-0 break-words text-[12px] text-[#42526B]">{children}</dd>
    </div>
  );
}

function GraphInspector({
  topology,
  selectedNode,
  selectedEdge,
  focusNetworkId,
  onFocusNetwork,
  onDisconnect,
  working,
}: {
  topology: Topology;
  selectedNode?: Node;
  selectedEdge?: Edge;
  focusNetworkId: string;
  onFocusNetwork: (networkId: string) => void;
  onDisconnect: (edge: Edge) => void;
  working: boolean;
}) {
  const data = selectedNode?.data as TopologyNodeData | undefined;
  const edgeData = selectedEdge?.data as TopologyEdgeData | undefined;

  if (!data && !edgeData) {
    return (
      <aside className="flex min-h-[220px] flex-col items-center justify-center px-6 py-8 text-center xl:min-h-0">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-[#EEF3F9] text-[#526070]">
          <NetworkIcon size={18} />
        </span>
        <strong className="text-[13px] text-[#172033]">Select a node or connection</strong>
        <p className="mt-1 max-w-[240px] text-xs leading-5 text-[#718096]">
          Inspect real topology state, focus a Network, or disconnect an existing relationship.
        </p>
      </aside>
    );
  }

  if (edgeData) {
    const applicationLink = edgeData.kind === "application-network";
    const network = topology.networks.find((item) => item.id === edgeData.networkId);
    const gate =
      edgeData.kind === "gate-network"
        ? topology.gates.find((item) => item.id === edgeData.gateId)
        : undefined;
    const appAttachment = applicationLink
      ? network?.attachments.find((item) => item.id === edgeData.attachmentId)
      : undefined;
    return (
      <aside className="min-w-0 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#718096]">Connection</p>
            <h3 className="mt-1 truncate text-[15px] font-semibold text-[#172033]">
              {applicationLink ? "Application → Network" : "Gate → Network"}
            </h3>
          </div>
          <StatusBadge tone={statusTone(edgeData.status)}>{edgeData.status}</StatusBadge>
        </div>
        <dl>
          <DetailRow label="From">
            {applicationLink ? appAttachment?.singleApp.name ?? "Application" : gate?.name ?? "Gate"}
          </DetailRow>
          <DetailRow label="To">{network?.name ?? "Network"}</DetailRow>
          {applicationLink ? <DetailRow label="Address"><code>{edgeData.address}</code></DetailRow> : null}
          {!applicationLink ? <DetailRow label="Transport">WireGuard routed VPN</DetailRow> : null}
          {edgeData.kind === "gate-network" && edgeData.lastError ? (
            <DetailRow label="Last error">{edgeData.lastError}</DetailRow>
          ) : null}
        </dl>
        <div className="mt-5">
          <ConfirmActionButton
            size="sm"
            triggerVariant="secondary"
            disabled={working}
            confirmTitle="Disconnect topology connection?"
            confirmDescription={
              applicationLink
                ? "The desired state changes immediately. Deploy the affected App Group to apply it to the runtime."
                : "The Gate route is removed and reconciled automatically."
            }
            confirmLabel="Disconnect"
            onConfirm={() => onDisconnect(selectedEdge!)}
          >
            Disconnect
          </ConfirmActionButton>
        </div>
      </aside>
    );
  }

  if (!data) return null;

  if (data.kind === "network") {
    const network = topology.networks.find((item) => item.id === data.networkId);
    return (
      <aside className="min-w-0 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#1769E0]">Network</p>
            <h3 className="mt-1 truncate text-[15px] font-semibold text-[#172033]">{data.label}</h3>
          </div>
          <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
        </div>
        <dl>
          <DetailRow label="CIDR"><code>{data.cidr}</code></DetailRow>
          <DetailRow label="Overlay"><code>{data.overlayCidr}</code></DetailRow>
          <DetailRow label="Apps">{network?.attachments.length ?? 0}</DetailRow>
          <DetailRow label="Gates">{network?.gateAttachments.length ?? 0}</DetailRow>
          <DetailRow label="Revision">{data.revision}</DetailRow>
          <DetailRow label="Observed">{formatDate(network?.lastObservedAt)}</DetailRow>
          {data.lastError ? <DetailRow label="Last error">{data.lastError}</DetailRow> : null}
        </dl>
        <div className="mt-5">
          <Button
            size="sm"
            variant={focusNetworkId === data.networkId ? "secondary" : "primary"}
            onClick={() => onFocusNetwork(focusNetworkId === data.networkId ? "" : data.networkId)}
          >
            {focusNetworkId === data.networkId ? "Show all networks" : "Focus this Network"}
          </Button>
        </div>
      </aside>
    );
  }

  if (data.kind === "application") {
    const group = topology.appGroups.find((item) => item.id === data.appGroupId);
    const app = group?.singleApps.find((item) => item.id === data.appId);
    return (
      <aside className="min-w-0 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#1769E0]">Application</p>
            <h3 className="mt-1 truncate text-[15px] font-semibold text-[#172033]">{data.label}</h3>
          </div>
          <StatusBadge tone={statusTone(data.runtimeState)}>{data.runtimeState || "Unknown"}</StatusBadge>
        </div>
        <dl>
          <DetailRow label="App Group">{data.groupName}</DetailRow>
          <DetailRow label="Image">{app?.image || "—"}</DetailRow>
          <DetailRow label="Networks">{app?.networkAttachments.length ?? 0}</DetailRow>
          <DetailRow label="Deploy state">{data.pending ? "Pending changes" : "In sync"}</DetailRow>
        </dl>
      </aside>
    );
  }

  if (data.kind === "app-group") {
    const group = topology.appGroups.find((item) => item.id === data.appGroupId);
    return (
      <aside className="min-w-0 p-5">
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#718096]">App Group</p>
          <h3 className="mt-1 truncate text-[15px] font-semibold text-[#172033]">{data.label}</h3>
        </div>
        <dl>
          <DetailRow label="Apps">{group?.singleApps.length ?? 0}</DetailRow>
          <DetailRow label="Deployment">{data.deploymentVersion ?? "Not deployed"}</DetailRow>
          <DetailRow label="Internal net">
            {data.internalNetworkName ? <code className="break-all">{data.internalNetworkName}</code> : "Not created"}
          </DetailRow>
          <DetailRow label="State">{data.pending ? "Pending changes" : "In sync"}</DetailRow>
        </dl>
      </aside>
    );
  }

  const gate = topology.gates.find((item) => item.id === data.gateId);
  return (
    <aside className="min-w-0 p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#137A4A]">ResourcePortalGate</p>
          <h3 className="mt-1 truncate text-[15px] font-semibold text-[#172033]">{data.label}</h3>
        </div>
        <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
      </div>
      <dl>
        <DetailRow label="LAN">{gate?.lanAddresses?.join(", ") || "Not reported"}</DetailRow>
        <DetailRow label="LAN CIDRs">{gate?.lanCidrs?.join(", ") || "Not reported"}</DetailRow>
        <DetailRow label="Tunnel">{gate?.clientTunnelAddress || "—"}</DetailRow>
        <DetailRow label="Networks">{gate?.networks.length ?? 0}</DetailRow>
        <DetailRow label="Last seen">{formatDate(data.lastSeenAt)}</DetailRow>
        <DetailRow label="Agent">{gate?.agentVersion || "—"}</DetailRow>
        {data.lastError ? <DetailRow label="Last error">{data.lastError}</DetailRow> : null}
      </dl>
    </aside>
  );
}

export function TenantNetworkingGraph({
  topology,
  working,
  onConnect,
  onDisconnect,
}: {
  topology: Topology;
  working: boolean;
  onConnect: (connection: Connection) => void | Promise<void>;
  onDisconnect: (edge: Edge) => void | Promise<void>;
}) {
  const [filters, setFilters] = useState<TopologyGraphFilters>({
    query: "",
    focusNetworkId: "",
    showApplications: true,
    showGates: true,
    status: "all",
  });
  const graph = useMemo(() => buildTopologyGraph(topology, filters), [topology, filters]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(graph.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [flow, setFlow] = useState<ReactFlowInstance<Node, Edge>>();

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
    if (selectedNodeId && !graph.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
    if (selectedEdgeId && !graph.edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(undefined);
    }
  }, [graph, selectedEdgeId, selectedNodeId, setEdges, setNodes]);

  useEffect(() => {
    if (!flow) return;
    const timeout = window.setTimeout(() => {
      void flow.fitView({ padding: 0.16, duration: 220, maxZoom: 1.15 });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    flow,
    filters.focusNetworkId,
    filters.query,
    filters.showApplications,
    filters.showGates,
    filters.status,
  ]);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const resetView = () => {
    setFilters({
      query: "",
      focusNetworkId: "",
      showApplications: true,
      showGates: true,
      status: "all",
    });
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  };

  const emptyGraph = nodes.length === 0;

  return (
    <>
      <div className="border-b border-[#E1E7F0] bg-white px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-[#172033]">Network Control Center</h2>
              {filters.focusNetworkId ? <StatusBadge tone="info">Focused</StatusBadge> : null}
              {working ? <StatusBadge tone="warning">Applying change…</StatusBadge> : null}
            </div>
            <p className="mt-1 text-xs text-[#718096]">
              App Groups contain their real applications. Lines represent real Network attachments and Gate routes.
            </p>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 xl:max-w-[760px] xl:justify-end">
            <SearchField
              value={filters.query}
              onChange={(query) => setFilters((current) => ({ ...current, query }))}
              placeholder="Search apps, Networks, Gates, CIDRs…"
              ariaLabel="Search network topology"
            />
            <Select
              aria-label="Focus Network"
              value={filters.focusNetworkId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, focusNetworkId: event.target.value }))
              }
              className="w-full sm:w-[190px]"
            >
              <option value="">All Networks</option>
              {topology.networks.map((network) => (
                <option key={network.id} value={network.id}>{network.name}</option>
              ))}
            </Select>
            <Select
              aria-label="Topology status filter"
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value as TopologyGraphFilters["status"],
                }))
              }
              className="w-full sm:w-[150px]"
            >
              <option value="all">All states</option>
              <option value="attention">Needs attention</option>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-label="Topology object filters">
            <button
              type="button"
              aria-pressed={filters.showApplications}
              onClick={() =>
                setFilters((current) => ({ ...current, showApplications: !current.showApplications }))
              }
              className={cx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0]",
                filters.showApplications
                  ? "border-[#CADDF7] bg-[#E7F1FF] text-[#135FBB]"
                  : "border-[#D7E0EC] bg-white text-[#718096]",
              )}
            >
              <GridIcon size={14} /> Applications
            </button>
            <button
              type="button"
              aria-pressed={filters.showGates}
              onClick={() =>
                setFilters((current) => ({ ...current, showGates: !current.showGates }))
              }
              className={cx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1769E0]",
                filters.showGates
                  ? "border-[#C9EBD9] bg-[#E9F7F0] text-[#137A4A]"
                  : "border-[#D7E0EC] bg-white text-[#718096]",
              )}
            >
              <ServerIcon size={14} /> Gates
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[#718096]">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#1769E0]" />App route</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#137A4A]" />WireGuard route</span>
            {(filters.query || filters.focusNetworkId || filters.status !== "all" || !filters.showApplications || !filters.showGates) ? (
              <Button size="sm" variant="ghost" onClick={resetView}>Reset view</Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative min-h-[560px] border-b border-[#E1E7F0] bg-[#F8FAFD] xl:min-h-[680px] xl:border-b-0 xl:border-r">
          {emptyGraph ? (
            <div className="flex h-full min-h-[560px] items-center justify-center px-6 text-center">
              <div>
                <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[#E7F1FF] text-[#1769E0]">
                  <NetworkIcon size={20} />
                </span>
                <strong className="mt-3 block text-sm text-[#172033]">No topology matches this view</strong>
                <p className="mt-1 text-xs text-[#718096]">
                  Reset the filters or create networking resources.
                </p>
                <Button className="mt-4" size="sm" onClick={resetView}>Reset view</Button>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={setFlow}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(connection) => void onConnect(connection)}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(undefined);
              }}
              onNodeDoubleClick={(_, node) => {
                const data = node.data as TopologyNodeData | undefined;
                if (data?.kind === "network") {
                  setFilters((current) => ({ ...current, focusNetworkId: data.networkId }));
                }
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(undefined);
              }}
              onPaneClick={() => {
                setSelectedNodeId(undefined);
                setSelectedEdgeId(undefined);
              }}
              nodesConnectable={!working}
              nodesDraggable
              edgesFocusable
              nodesFocusable
              elementsSelectable
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
              minZoom={0.28}
              maxZoom={1.65}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
              connectionLineStyle={{ stroke: "#1769E0", strokeWidth: 2 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#D7E0EC" />
              <MiniMap
                pannable
                zoomable
                nodeColor={(node) =>
                  node.type === "network"
                    ? "#8BB7ED"
                    : node.type === "gate"
                      ? "#B8D9C8"
                      : "#D7E0EC"
                }
                maskColor="rgba(248,250,253,.72)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        <div className="min-w-0 bg-white">
          <GraphInspector
            topology={topology}
            selectedNode={selectedNode}
            selectedEdge={selectedEdge}
            focusNetworkId={filters.focusNetworkId}
            onFocusNetwork={(networkId) =>
              setFilters((current) => ({ ...current, focusNetworkId: networkId }))
            }
            onDisconnect={(edge) => void onDisconnect(edge)}
            working={working}
          />
        </div>
      </div>
    </>
  );
}
