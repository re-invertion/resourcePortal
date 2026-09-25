import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiRequest } from "../api/client";
import {
  Button,
  Callout,
  Card,
  ConfirmActionButton,
  CopyIcon,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  GridIcon,
  NetworkIcon,
  PageHeader,
  PlusIcon,
  ServerIcon,
  StatusBadge,
  TextInput,
  TrashIcon,
  statusTone,
} from "../components/design-system";
import { formatDate, useApi } from "../hooks/use-api";

type ApplicationAttachment = {
  id: string;
  networkId: string;
  address: string;
};

type Application = {
  id: string;
  name: string;
  image?: string;
  runtimeState?: string;
  networkAttachments: ApplicationAttachment[];
};

type AppGroup = {
  id: string;
  name: string;
  hasPendingChanges: boolean;
  singleApps: Application[];
};

type NetworkAttachment = {
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

type NetworkResource = {
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

type GateNetworkLink = {
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

type GateResource = {
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

type Topology = {
  networks: NetworkResource[];
  gates: GateResource[];
  appGroups: AppGroup[];
};

type Operation = {
  id: string;
  status: string;
  errorMessage?: string | null;
};

type EnrollmentResponse = {
  gateId?: string;
  endpointHost?: string;
  enrollment: {
    token: string;
    expiresAt: string;
  };
  gate?: GateResource;
};

type TopologyNodeData =
  | {
      kind: "application";
      appId: string;
      appGroupId: string;
      label: string;
      groupName: string;
      runtimeState?: string;
      pending: boolean;
    }
  | {
      kind: "network";
      networkId: string;
      label: string;
      cidr: string;
      revision: number;
      status: string;
      attachmentCount: number;
    }
  | {
      kind: "gate";
      gateId: string;
      label: string;
      status: string;
      revision: number;
      lanAddress?: string;
      lastSeenAt?: string | null;
    };

type TopologyEdgeData =
  | {
      kind: "application-network";
      networkId: string;
      attachmentId: string;
      revision: number;
      address: string;
    }
  | {
      kind: "gate-network";
      gateId: string;
      networkId: string;
      revision: number;
    };

function nodeData(props: NodeProps) {
  return props.data as unknown as TopologyNodeData;
}

function ApplicationNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "application") return null;
  return (
    <div className="min-w-[230px] rounded-xl border border-[#C9D6E7] bg-white px-4 py-3 shadow-[0_4px_16px_rgba(36,74,120,.08)]">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]">
          <GridIcon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] text-[#172033]">{data.label}</strong>
          <span className="mt-0.5 block truncate text-[11px] text-[#718096]">{data.groupName}</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge tone={statusTone(data.runtimeState)}>{data.runtimeState || "Unknown"}</StatusBadge>
            {data.pending ? <StatusBadge tone="warning">Pending deploy</StatusBadge> : null}
          </div>
        </div>
      </div>
      <Handle
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
    <div className="min-w-[250px] rounded-xl border-2 border-[#8BB7ED] bg-[#F7FBFF] px-4 py-3 shadow-[0_5px_18px_rgba(23,105,224,.10)]">
      <Handle
        id="applications"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-white !bg-[#1769E0]"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#DDEEFF] text-[#1769E0]">
          <NetworkIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-sm text-[#172033]">{data.label}</strong>
          <code className="mt-1 block text-[11px] text-[#526070]">{data.cidr}</code>
          <div className="mt-2 flex items-center justify-between gap-2">
            <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
            <span className="text-[11px] text-[#718096]">{data.attachmentCount} apps · rev {data.revision}</span>
          </div>
        </div>
      </div>
      <Handle
        id="gates"
        type="target"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-white !bg-[#137A4A]"
      />
    </div>
  );
}

function GateNode(props: NodeProps) {
  const data = nodeData(props);
  if (data.kind !== "gate") return null;
  return (
    <div className="min-w-[240px] rounded-xl border border-[#B8D9C8] bg-[#F6FCF8] px-4 py-3 shadow-[0_4px_16px_rgba(19,122,74,.08)]">
      <Handle
        type="source"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-white !bg-[#137A4A]"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E2F5EB] text-[#137A4A]">
          <ServerIcon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] text-[#172033]">{data.label}</strong>
          <span className="mt-0.5 block truncate text-[11px] text-[#718096]">
            {data.lanAddress ? `LAN ${data.lanAddress}` : "Awaiting LAN address"}
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge tone={statusTone(data.status)}>{data.status}</StatusBadge>
            <span className="self-center text-[11px] text-[#718096]">rev {data.revision}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  application: ApplicationNode,
  network: NetworkNode,
  gate: GateNode,
};

function topologyNodes(data: Topology): Node[] {
  const nodes: Node[] = [];
  let appIndex = 0;
  for (const group of data.appGroups) {
    for (const app of group.singleApps) {
      nodes.push({
        id: `app:${app.id}`,
        type: "application",
        position: { x: 20, y: 30 + appIndex * 130 },
        data: {
          kind: "application",
          appId: app.id,
          appGroupId: group.id,
          label: app.name,
          groupName: group.name,
          runtimeState: app.runtimeState,
          pending: group.hasPendingChanges,
        } satisfies TopologyNodeData,
      });
      appIndex += 1;
    }
  }

  data.networks.forEach((network, index) => {
    nodes.push({
      id: `network:${network.id}`,
      type: "network",
      position: { x: 410, y: 30 + index * 155 },
      data: {
        kind: "network",
        networkId: network.id,
        label: network.name,
        cidr: network.cidr,
        revision: network.revision,
        status: network.status,
        attachmentCount: network.attachments.length,
      } satisfies TopologyNodeData,
    });
  });

  data.gates.forEach((gate, index) => {
    nodes.push({
      id: `gate:${gate.id}`,
      type: "gate",
      position: { x: 820, y: 30 + index * 155 },
      data: {
        kind: "gate",
        gateId: gate.id,
        label: gate.name,
        status: gate.status,
        revision: gate.configRevision,
        lanAddress: gate.lanAddresses?.[0],
        lastSeenAt: gate.lastSeenAt,
      } satisfies TopologyNodeData,
    });
  });
  return nodes;
}

function topologyEdges(data: Topology): Edge[] {
  const edges: Edge[] = [];
  for (const network of data.networks) {
    for (const attachment of network.attachments) {
      edges.push({
        id: `app-edge:${attachment.id}`,
        source: `app:${attachment.singleAppId}`,
        target: `network:${network.id}`,
        data: {
          kind: "application-network",
          networkId: network.id,
          attachmentId: attachment.id,
          revision: network.revision,
          address: attachment.address,
        } satisfies TopologyEdgeData,
        label: attachment.address,
        animated: false,
        style: { strokeWidth: 2 },
      });
    }
  }
  for (const gate of data.gates) {
    for (const link of gate.networks ?? []) {
      edges.push({
        id: `gate-edge:${gate.id}:${link.network.id}`,
        source: `gate:${gate.id}`,
        target: `network:${link.network.id}`,
        data: {
          kind: "gate-network",
          gateId: gate.id,
          networkId: link.network.id,
          revision: gate.configRevision,
        } satisfies TopologyEdgeData,
        label: "routed VPN",
        animated: gate.status === "Ready",
        style: { strokeWidth: 2 },
      });
    }
  }
  return edges;
}

function operationTerminal(status: string) {
  return ["Succeeded", "Failed", "RolledBack", "RollbackFailed"].includes(status);
}

async function waitForOperation(tenantId: string, operation: Operation) {
  let current = operation;
  for (let attempt = 0; attempt < 60 && !operationTerminal(current.status); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    current = await apiRequest<Operation>(
      `/api/tenants/${encodeURIComponent(tenantId)}/operations/${encodeURIComponent(operation.id)}`,
    );
  }
  if (current.status !== "Succeeded" && current.status !== "RolledBack") {
    throw new Error(current.errorMessage || `Topology operation ended with ${current.status}`);
  }
  return current;
}

function installCommand(response: EnrollmentResponse) {
  if (typeof window === "undefined") return "";
  const origin = window.location.origin;
  return `curl -fsSL ${origin}/api/networking/gates/install.sh | sudo bash -s -- --url ${origin}/api --token '${response.enrollment.token}'`;
}

export function TenantNetworkingPage({ tenantId }: { tenantId: string }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/networking`;
  const topology = useApi<Topology>(`${root}/topology`);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedEdge, setSelectedEdge] = useState<Edge>();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; message: string }>();
  const [networkOpen, setNetworkOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [networkForm, setNetworkForm] = useState({ name: "", description: "", cidr: "" });
  const [gateForm, setGateForm] = useState({ name: "", description: "" });
  const [enrollment, setEnrollment] = useState<EnrollmentResponse>();

  useEffect(() => {
    if (!topology.data) return;
    setNodes(topologyNodes(topology.data));
    setEdges(topologyEdges(topology.data));
  }, [topology.data, setEdges, setNodes]);

  const nodeMap = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  const submitConnection = useCallback(
    async (connection: Connection) => {
      const source = connection.source ? nodeMap.get(connection.source) : undefined;
      const target = connection.target ? nodeMap.get(connection.target) : undefined;
      const sourceData = source?.data as TopologyNodeData | undefined;
      const targetData = target?.data as TopologyNodeData | undefined;
      if (!sourceData || !targetData || targetData.kind !== "network") {
        setNotice({
          tone: "danger",
          message: "Connect an Application or ResourcePortalGate node to a Network node.",
        });
        return;
      }

      setWorking(true);
      setNotice(undefined);
      try {
        let operation: Operation;
        const headers = { "idempotency-key": crypto.randomUUID() };
        if (sourceData.kind === "application") {
          operation = await apiRequest<Operation>(
            `${root}/networks/${encodeURIComponent(targetData.networkId)}/attachments`,
            {
              method: "POST",
              headers,
              body: {
                singleAppId: sourceData.appId,
                expectedRevision: targetData.revision,
              },
            },
          );
        } else if (sourceData.kind === "gate") {
          operation = await apiRequest<Operation>(
            `${root}/gates/${encodeURIComponent(sourceData.gateId)}/networks`,
            {
              method: "POST",
              headers,
              body: {
                networkId: targetData.networkId,
                expectedRevision: sourceData.revision,
              },
            },
          );
        } else {
          throw new Error("Only Applications and Gates can initiate Network connections.");
        }
        await waitForOperation(tenantId, operation);
        await topology.reload();
        setNotice({
          tone: "success",
          message:
            sourceData.kind === "application"
              ? "Application connected. Deploy the affected App Group to apply the new Network attachment."
              : "ResourcePortalGate route connected and queued for runtime reconciliation.",
        });
      } catch (error) {
        setNotice({
          tone: "danger",
          message: error instanceof Error ? error.message : "Unable to connect topology nodes.",
        });
      } finally {
        setWorking(false);
      }
    },
    [nodeMap, root, tenantId, topology],
  );

  async function disconnectSelected() {
    const data = selectedEdge?.data as TopologyEdgeData | undefined;
    if (!data) return;
    setWorking(true);
    setNotice(undefined);
    try {
      let operation: Operation;
      const headers = { "idempotency-key": crypto.randomUUID() };
      if (data.kind === "application-network") {
        operation = await apiRequest<Operation>(
          `${root}/networks/${encodeURIComponent(data.networkId)}/attachments/${encodeURIComponent(data.attachmentId)}?revision=${data.revision}`,
          { method: "DELETE", headers },
        );
      } else {
        operation = await apiRequest<Operation>(
          `${root}/gates/${encodeURIComponent(data.gateId)}/networks/${encodeURIComponent(data.networkId)}?revision=${data.revision}`,
          { method: "DELETE", headers },
        );
      }
      await waitForOperation(tenantId, operation);
      setSelectedEdge(undefined);
      await topology.reload();
      setNotice({
        tone: "success",
        message:
          data.kind === "application-network"
            ? "Application disconnected. Deploy the App Group to apply the change."
            : "Gate route disconnected.",
      });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to disconnect topology edge.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function createNetwork(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNotice(undefined);
    try {
      await apiRequest(`${root}/networks`, {
        method: "POST",
        body: {
          name: networkForm.name.trim(),
          description: networkForm.description.trim() || undefined,
          cidr: networkForm.cidr.trim() || undefined,
        },
      });
      setNetworkForm({ name: "", description: "", cidr: "" });
      setNetworkOpen(false);
      await topology.reload();
      setNotice({ tone: "success", message: "Network created." });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to create Network.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function createGate(event: FormEvent) {
    event.preventDefault();
    setWorking(true);
    setNotice(undefined);
    try {
      const response = await apiRequest<EnrollmentResponse>(`${root}/gates`, {
        method: "POST",
        body: {
          name: gateForm.name.trim(),
          description: gateForm.description.trim() || undefined,
        },
      });
      setEnrollment(response);
      setGateForm({ name: "", description: "" });
      await topology.reload();
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to create ResourcePortalGate.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function rotateEnrollment(gate: GateResource) {
    setWorking(true);
    setNotice(undefined);
    try {
      const response = await apiRequest<EnrollmentResponse>(
        `${root}/gates/${encodeURIComponent(gate.id)}/enrollment`,
        { method: "POST" },
      );
      setEnrollment(response);
      setGateOpen(true);
      await topology.reload();
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to rotate Gate enrollment.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function deleteNetwork(network: NetworkResource) {
    setWorking(true);
    try {
      await apiRequest(`${root}/networks/${encodeURIComponent(network.id)}`, {
        method: "DELETE",
      });
      await topology.reload();
      setNotice({ tone: "success", message: `Network ${network.name} deleted.` });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to delete Network.",
      });
    } finally {
      setWorking(false);
    }
  }

  async function revokeGate(gate: GateResource) {
    setWorking(true);
    try {
      await apiRequest(`${root}/gates/${encodeURIComponent(gate.id)}`, {
        method: "DELETE",
      });
      await topology.reload();
      setNotice({ tone: "warning", message: `ResourcePortalGate ${gate.name} revoked.` });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to revoke Gate.",
      });
    } finally {
      setWorking(false);
    }
  }

  const networkRows = (topology.data?.networks ?? []).map((network) => ({
    key: network.id,
    cells: {
      network: (
        <div>
          <strong className="block text-[13px] text-[#172033]">{network.name}</strong>
          <code className="text-[11px] text-[#718096]">{network.cidr}</code>
        </div>
      ),
      status: <StatusBadge tone={statusTone(network.status)}>{network.status}</StatusBadge>,
      apps: network.attachments.length,
      gates: network.gateAttachments.length,
      revision: network.revision,
      actions: (
        <ConfirmActionButton
          size="sm"
          triggerVariant="ghost"
          disabled={working || network.attachments.length > 0 || network.gateAttachments.length > 0}
          confirmTitle="Delete Network?"
          confirmDescription="A Network can only be deleted after every application and Gate has been disconnected."
          confirmLabel="Delete Network"
          onConfirm={() => deleteNetwork(network)}
        >
          <TrashIcon size={14} /> Delete
        </ConfirmActionButton>
      ),
    },
  }));

  const gateRows = (topology.data?.gates ?? []).map((gate) => ({
    key: gate.id,
    cells: {
      gate: (
        <div>
          <strong className="block text-[13px] text-[#172033]">{gate.name}</strong>
          <span className="text-[11px] text-[#718096]">
            {gate.lanAddresses?.length ? gate.lanAddresses.join(", ") : "LAN address not reported"}
          </span>
        </div>
      ),
      status: <StatusBadge tone={statusTone(gate.status)}>{gate.status}</StatusBadge>,
      networks: gate.networks?.length ?? 0,
      lastSeen: formatDate(gate.lastSeenAt),
      actions: (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={working || Boolean(gate.revokedAt)} onClick={() => void rotateEnrollment(gate)}>
            Re-enroll
          </Button>
          <ConfirmActionButton
            size="sm"
            triggerVariant="ghost"
            disabled={working || Boolean(gate.revokedAt)}
            confirmTitle="Revoke ResourcePortalGate?"
            confirmDescription="The RP-side VPN stack is removed and the agent token becomes invalid."
            confirmLabel="Revoke Gate"
            onConfirm={() => revokeGate(gate)}
          >
            Revoke
          </ConfirmActionButton>
        </div>
      ),
    },
  }));

  const routeRows = (topology.data?.gates ?? []).flatMap((gate) =>
    (gate.networks ?? []).map((link) => ({
      key: `${gate.id}:${link.network.id}`,
      cells: {
        gate: gate.name,
        network: (
          <div>
            <strong className="block text-[13px]">{link.network.name}</strong>
            <code className="text-[11px] text-[#718096]">{link.network.cidr}</code>
          </div>
        ),
        nextHop: gate.lanAddresses?.[0] ? (
          <code className="text-xs">{gate.lanAddresses[0]}</code>
        ) : (
          <span className="text-xs text-[#9A6700]">Awaiting LAN address</span>
        ),
        route: gate.lanAddresses?.[0] ? (
          <code className="break-all text-[11px]">
            {link.network.cidr} via {gate.lanAddresses[0]}
          </code>
        ) : (
          "—"
        ),
      },
    })),
  );

  const command = enrollment ? installCommand(enrollment) : "";

  return (
    <main>
      <PageHeader
        eyebrow="Tenant networking"
        title="Networking"
        description="Connect applications across App Groups with tenant-scoped Networks and route selected private Networks into your LAN through ResourcePortalGate."
        actions={
          <>
            <Button onClick={() => setNetworkOpen(true)}>
              <PlusIcon size={15} /> Create Network
            </Button>
            <Button variant="primary" onClick={() => { setEnrollment(undefined); setGateOpen(true); }}>
              <PlusIcon size={15} /> Add Gate
            </Button>
          </>
        }
      />

      {notice ? (
        <div className="mb-5">
          <Callout tone={notice.tone} title={notice.message} />
        </div>
      ) : null}
      {topology.error ? (
        <div className="mb-5">
          <Callout tone="danger" title="Networking topology unavailable">
            {topology.error instanceof Error ? topology.error.message : "The topology API could not be loaded."}
          </Callout>
        </div>
      ) : null}

      <Callout
        title="How to connect"
        action={selectedEdge ? (
          <ConfirmActionButton
            size="sm"
            triggerVariant="ghost"
            disabled={working}
            confirmTitle="Disconnect selected topology edge?"
            confirmDescription="Application changes require an App Group deployment. Gate route changes reconcile automatically."
            confirmLabel="Disconnect"
            onConfirm={disconnectSelected}
          >
            Disconnect selected
          </ConfirmActionButton>
        ) : undefined}
      >
        Drag from an Application or ResourcePortalGate handle into a Network. Select an existing edge to disconnect it. Application edges update desired state and require Deploy changes in that App Group.
      </Callout>

      <Card className="mt-5 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E1E7F0] px-5 py-3">
          <div>
            <h2 className="font-semibold text-[#172033]">Topology</h2>
            <p className="mt-0.5 text-xs text-[#718096]">
              Applications → tenant Networks ← ResourcePortalGate
            </p>
          </div>
          {working ? <StatusBadge tone="warning">Applying change…</StatusBadge> : <StatusBadge tone="success">Interactive</StatusBadge>}
        </div>
        <div className="h-[620px] min-h-[420px] bg-[#F8FAFD]">
          {(topology.data?.networks.length ?? 0) === 0 &&
          (topology.data?.appGroups.flatMap((group) => group.singleApps).length ?? 0) === 0 &&
          (topology.data?.gates.length ?? 0) === 0 &&
          !topology.loading ? (
            <EmptyState
              icon={<NetworkIcon />}
              title="No networking resources yet"
              description="Create a Network, then connect applications or add a ResourcePortalGate."
              action={<Button variant="primary" onClick={() => setNetworkOpen(true)}>Create Network</Button>}
            />
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={(connection) => void submitConnection(connection)}
              onEdgeClick={(_, edge) => setSelectedEdge(edge)}
              onPaneClick={() => setSelectedEdge(undefined)}
              edgesFocusable
              nodesConnectable={!working}
              nodesDraggable
              fitView
              fitViewOptions={{ padding: 0.18 }}
              minZoom={0.35}
              maxZoom={1.6}
              deleteKeyCode={null}
            >
              <Background gap={22} size={1} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          )}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-[#E1E7F0] px-5 py-4">
            <h2 className="font-semibold text-[#172033]">Networks</h2>
            <p className="mt-1 text-xs text-[#718096]">Stable VPN CIDRs are separate from internal Swarm overlay CIDRs.</p>
          </div>
          <DataTable
            embedded
            loading={topology.loading}
            columns={[
              { key: "network", label: "Network" },
              { key: "status", label: "Status" },
              { key: "apps", label: "Apps" },
              { key: "gates", label: "Gates" },
              { key: "revision", label: "Rev" },
              { key: "actions", label: "" },
            ]}
            rows={networkRows}
            empty={<EmptyState icon={<NetworkIcon />} title="No Networks" description="Create a tenant Network to connect applications." />}
          />
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-[#E1E7F0] px-5 py-4">
            <h2 className="font-semibold text-[#172033]">ResourcePortalGate</h2>
            <p className="mt-1 text-xs text-[#718096]">Outbound control agent plus WireGuard routed VPN. No Docker socket or control-plane secrets on the LAN host.</p>
          </div>
          <DataTable
            embedded
            loading={topology.loading}
            columns={[
              { key: "gate", label: "Gate" },
              { key: "status", label: "Status" },
              { key: "networks", label: "Networks" },
              { key: "lastSeen", label: "Last seen" },
              { key: "actions", label: "" },
            ]}
            rows={gateRows}
            empty={<EmptyState icon={<ServerIcon />} title="No Gate instances" description="Add a Gate to route selected RP Networks into your LAN." />}
          />
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <h2 className="font-semibold text-[#172033]">LAN route plan</h2>
          <p className="mt-1 text-xs text-[#718096]">
            If the Gate host is not the LAN default gateway, configure these static routes on your LAN router. ResourcePortal does not use proxy ARP or extend layer 2.
          </p>
        </div>
        <DataTable
          embedded
          loading={topology.loading}
          columns={[
            { key: "gate", label: "Gate" },
            { key: "network", label: "RP Network" },
            { key: "nextHop", label: "LAN next-hop" },
            { key: "route", label: "Static route" },
          ]}
          rows={routeRows}
          empty={<EmptyState icon={<NetworkIcon />} title="No exported routes" description="Connect a ResourcePortalGate node to a Network node." />}
        />
      </Card>

      <Dialog
        open={networkOpen}
        onClose={() => { if (!working) setNetworkOpen(false); }}
        title="Create Network"
        description="Creates a tenant-scoped private connectivity domain. CIDR is automatically allocated when left blank."
        actions={
          <>
            <Button disabled={working} onClick={() => setNetworkOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="create-network-form" disabled={working || !networkForm.name.trim()}>
              {working ? "Creating…" : "Create Network"}
            </Button>
          </>
        }
      >
        <form id="create-network-form" className="space-y-4" onSubmit={(event) => void createNetwork(event)}>
          <Field label="Name" required hint="Lowercase letters, numbers and hyphens.">
            <TextInput value={networkForm.name} onChange={(event) => setNetworkForm({ ...networkForm, name: event.target.value })} placeholder="backend" />
          </Field>
          <Field label="CIDR" hint="Optional private IPv4 CIDR (/16 through /28). Default pool: automatically allocated.">
            <TextInput value={networkForm.cidr} onChange={(event) => setNetworkForm({ ...networkForm, cidr: event.target.value })} placeholder="10.240.20.0/24" />
          </Field>
          <Field label="Description">
            <TextInput value={networkForm.description} onChange={(event) => setNetworkForm({ ...networkForm, description: event.target.value })} placeholder="Shared backend connectivity" />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={gateOpen}
        onClose={() => { if (!working) { setGateOpen(false); setEnrollment(undefined); } }}
        title={enrollment ? "Install ResourcePortalGate" : "Add ResourcePortalGate"}
        description={enrollment ? "Run this one-time command on the Linux host that will route your LAN into selected RP Networks." : "Create a routed VPN gateway for this tenant."}
        actions={
          enrollment ? (
            <Button variant="primary" onClick={() => { setGateOpen(false); setEnrollment(undefined); }}>Done</Button>
          ) : (
            <>
              <Button disabled={working} onClick={() => setGateOpen(false)}>Cancel</Button>
              <Button variant="primary" type="submit" form="create-gate-form" disabled={working || !gateForm.name.trim()}>
                {working ? "Creating…" : "Create Gate"}
              </Button>
            </>
          )
        }
      >
        {enrollment ? (
          <div className="space-y-4">
            <Callout tone="warning" title="Enrollment token is shown for this install flow">
              It expires at {formatDate(enrollment.enrollment.expiresAt)}. Re-enrolling invalidates the previous agent token.
            </Callout>
            <div className="rounded-lg border border-[#D7E0EC] bg-[#0F1724] p-4 text-white">
              <div className="flex items-start justify-between gap-3">
                <code className="min-w-0 flex-1 select-all break-all text-xs leading-5">{command}</code>
                <Button
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(command)}
                >
                  <CopyIcon size={14} /> Copy
                </Button>
              </div>
            </div>
            <p className="text-xs leading-5 text-[#5B6678]">
              The installer generates the client WireGuard key locally, installs a systemd service, reports LAN interface addresses/CIDRs and keeps route configuration synchronized.
            </p>
          </div>
        ) : (
          <form id="create-gate-form" className="space-y-4" onSubmit={(event) => void createGate(event)}>
            <Field label="Name" required>
              <TextInput value={gateForm.name} onChange={(event) => setGateForm({ ...gateForm, name: event.target.value })} placeholder="office-gateway" />
            </Field>
            <Field label="Description">
              <TextInput value={gateForm.description} onChange={(event) => setGateForm({ ...gateForm, description: event.target.value })} placeholder="Office LAN router" />
            </Field>
          </form>
        )}
      </Dialog>
    </main>
  );
}
