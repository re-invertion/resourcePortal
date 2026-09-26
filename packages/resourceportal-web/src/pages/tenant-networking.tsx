import { useState, type FormEvent } from "react";
import { type Connection, type Edge } from "@xyflow/react";
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
import {
  TenantNetworkingGraph,
  type GateResource,
  type NetworkResource,
  type Topology,
  type TopologyEdgeData,
} from "./tenant-networking-graph";

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
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; message: string }>();
  const [networkOpen, setNetworkOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [networkForm, setNetworkForm] = useState({ name: "", description: "", cidr: "" });
  const [gateForm, setGateForm] = useState({ name: "", description: "" });
  const [enrollment, setEnrollment] = useState<EnrollmentResponse>();


  async function submitConnection(connection: Connection) {
    const sourceId = connection.source;
    const targetId = connection.target;
    if (!sourceId || !targetId?.startsWith("network:")) {
      setNotice({
        tone: "danger",
        message: "Connect an Application or ResourcePortalGate node to a Network node.",
      });
      return;
    }

    const networkId = targetId.slice("network:".length);
    const network = topology.data?.networks.find((item) => item.id === networkId);
    if (!network) {
      setNotice({ tone: "danger", message: "The selected Network is no longer available." });
      return;
    }

    setWorking(true);
    setNotice(undefined);
    try {
      let operation: Operation;
      const headers = { "idempotency-key": crypto.randomUUID() };
      if (sourceId.startsWith("app:")) {
        const appId = sourceId.slice("app:".length);
        const appExists = topology.data?.appGroups.some((group) =>
          group.singleApps.some((app) => app.id === appId),
        );
        if (!appExists) throw new Error("The selected Application is no longer available.");
        operation = await apiRequest<Operation>(
          `${root}/networks/${encodeURIComponent(network.id)}/attachments`,
          {
            method: "POST",
            headers,
            body: {
              singleAppId: appId,
              expectedRevision: network.revision,
            },
          },
        );
      } else if (sourceId.startsWith("gate:")) {
        const gateId = sourceId.slice("gate:".length);
        const gate = topology.data?.gates.find((item) => item.id === gateId);
        if (!gate) throw new Error("The selected ResourcePortalGate is no longer available.");
        operation = await apiRequest<Operation>(
          `${root}/gates/${encodeURIComponent(gate.id)}/networks`,
          {
            method: "POST",
            headers,
            body: {
              networkId: network.id,
              expectedRevision: gate.configRevision,
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
        message: sourceId.startsWith("app:")
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
  }

  async function disconnectEdge(edge: Edge) {
    const data = edge.data as TopologyEdgeData | undefined;
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

  async function deleteGate(gate: GateResource) {
    setWorking(true);
    try {
      await apiRequest(`${root}/gates/${encodeURIComponent(gate.id)}`, {
        method: "DELETE",
      });
      await topology.reload();
      setNotice({ tone: "success", message: `ResourcePortalGate ${gate.name} deletion requested.` });
    } catch (error) {
      setNotice({
        tone: "danger",
        message: error instanceof Error ? error.message : "Unable to delete Gate.",
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
            confirmTitle="Delete ResourcePortalGate?"
            confirmDescription="The agent token is invalidated immediately. The Gate record is permanently deleted after its RP-side VPN stack and private key secret are removed."
            confirmLabel="Delete Gate"
            onConfirm={() => deleteGate(gate)}
          >
            Delete
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

      <Callout title="How to connect">
        Drag from an Application or ResourcePortalGate handle into a Network. Click any node or connection to inspect its real state. Application connections update desired state and require Deploy changes in that App Group; Gate routes reconcile automatically.
      </Callout>

      <Card className="mt-5 overflow-hidden">
        {topology.data ? (
          <TenantNetworkingGraph
            topology={topology.data}
            working={working}
            onConnect={submitConnection}
            onDisconnect={disconnectEdge}
            onDeleteGate={deleteGate}
          />
        ) : (
          <div className="flex min-h-[420px] items-center justify-center bg-[#F8FAFD] px-6 text-sm text-[#718096]">
            {topology.loading ? "Loading network topology…" : "Network topology is unavailable."}
          </div>
        )}
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