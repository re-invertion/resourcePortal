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
  Select,
  ServerIcon,
  StatusBadge,
  Tabs,
  TextInput,
  TrashIcon,
  statusTone,
} from "../components/design-system";
import { formatDate, items, useApi } from "../hooks/use-api";
import {
  TenantNetworkingGraph,
  type GateResource,
  type NetworkResource,
  type Topology,
  type TopologyEdgeData,
} from "./tenant-networking-graph";
import { toast } from "../components/toast";
import { NetworkingTabs } from "../components/tenant-section-tabs";
import { DeviceVpnPanel } from "./device-vpn-panel";

type VpnDevice = { id: string; name: string; assignedAddress: string; address?: string; status: string; networks: Array<{ id: string; name: string }>; lastSeenAt?: string | null };
import { tenantHref } from "../router/router";
import {
  hasFormErrors,
  validateGateForm,
  validateNetworkForm,
  validateRoutingForm,
} from "./networking-form-validation";

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
  const devices = useApi<VpnDevice[]>(`${root}/device-vpn/devices`);
  const [deviceCreateRequestId, setDeviceCreateRequestId] = useState(0);
  const [deviceEditRequest, setDeviceEditRequest] = useState<{ id: string; nonce: number }>();
  const [deviceRefreshId, setDeviceRefreshId] = useState(0);
  const [working, setWorking] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [networkForm, setNetworkForm] = useState({ name: "", description: "", cidr: "" });
  const [networkErrors, setNetworkErrors] = useState<Record<string, string | undefined>>({});
  const [gateForm, setGateForm] = useState({ name: "", description: "" });
  const [gateErrors, setGateErrors] = useState<Record<string, string | undefined>>({});
  const [connectionGuidance, setConnectionGuidance] = useState<string>();
  const [enrollment, setEnrollment] = useState<EnrollmentResponse>();
  const [firewallGate, setFirewallGate] = useState<GateResource>();
  const [firewallOpen, setFirewallOpen] = useState(false);
  const [firewallForm, setFirewallForm] = useState({ allowLanToRp: true, allowRpToLan: false });
  const [routingGate, setRoutingGate] = useState<GateResource>();
  const [routingOpen, setRoutingOpen] = useState(false);
  const [routingForm, setRoutingForm] = useState({
    mode: "Manual" as "Manual" | "BGP",
    localAsn: "",
    routerAddress: "",
    routerAsn: "",
    sourceAddress: "",
    holdTimeSeconds: "90",
  });
  const [routingErrors, setRoutingErrors] = useState<Record<string, string | undefined>>({});


  async function submitConnection(connection: Connection) {
    let sourceId = connection.source;
    let targetId = connection.target;
    if (
      sourceId?.startsWith("network:") &&
      targetId &&
      (targetId.startsWith("app:") || targetId.startsWith("gate:"))
    ) {
      [sourceId, targetId] = [targetId, sourceId];
    }
    if (!sourceId || !targetId?.startsWith("network:")) {
      setConnectionGuidance(
        "Applications and Site VPN instances do not connect directly. Create or choose a Network, then connect both nodes to that same Network.",
      );
      return;
    }

    const networkId = targetId.slice("network:".length);
    const network = topology.data?.networks.find((item) => item.id === networkId);
    if (!network) {
      setConnectionGuidance("The selected Network is no longer available. Reload the topology and try again.");
      return;
    }

    setConnectionGuidance(undefined);
    setWorking(true);
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
        if (!gate) throw new Error("The selected Site VPN is no longer available.");
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
      toast.success(sourceId.startsWith("app:")
        ? "Application connected. Deploy the affected App Group to apply the new Network attachment."
        : "Site VPN route connected and queued for runtime reconciliation.");
    } catch (error) {
      toast.errorFrom(error, "Unable to connect topology nodes.");
    } finally {
      setWorking(false);
    }
  }

  async function disconnectEdge(edge: Edge) {
    const data = edge.data as TopologyEdgeData | undefined;
    if (!data || data.kind === "internet-route") return;
    setWorking(true);
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
      toast.success(data.kind === "application-network"
        ? "Application disconnected. Deploy the App Group to apply the change."
        : "Site VPN route disconnected.");
    } catch (error) {
      toast.errorFrom(error, "Unable to disconnect topology edge.");
    } finally {
      setWorking(false);
    }
  }

  async function createNetwork(event: FormEvent) {
    event.preventDefault();
    const errors = validateNetworkForm(networkForm);
    setNetworkErrors(errors);
    if (hasFormErrors(errors)) return;
    setWorking(true);
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
      setNetworkErrors({});
      setNetworkOpen(false);
      await topology.reload();
      toast.success("Network created.");
    } catch (error) {
      toast.errorFrom(error, "Unable to create Network.");
    } finally {
      setWorking(false);
    }
  }

  async function createGate(event: FormEvent) {
    event.preventDefault();
    const errors = validateGateForm(gateForm);
    setGateErrors(errors);
    if (hasFormErrors(errors)) return;
    setWorking(true);
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
      setGateErrors({});
      await topology.reload();
    } catch (error) {
      toast.errorFrom(error, "Unable to create Site VPN.");
    } finally {
      setWorking(false);
    }
  }

  async function rotateEnrollment(gate: GateResource) {
    setWorking(true);
    try {
      const response = await apiRequest<EnrollmentResponse>(
        `${root}/gates/${encodeURIComponent(gate.id)}/enrollment`,
        { method: "POST" },
      );
      setEnrollment(response);
      setGateOpen(true);
      await topology.reload();
    } catch (error) {
      toast.errorFrom(error, "Unable to rotate Site VPN enrollment.");
    } finally {
      setWorking(false);
    }
  }

  function editGateFirewall(gate: GateResource) {
    setFirewallGate(gate);
    setFirewallForm({ allowLanToRp: gate.allowLanToRp ?? true, allowRpToLan: gate.allowRpToLan ?? false });
    setFirewallOpen(true);
  }

  async function saveGateFirewall(event: FormEvent) {
    event.preventDefault();
    if (!firewallGate) return;
    setWorking(true);
    try {
      await apiRequest(
        `${root}/gates/${encodeURIComponent(firewallGate.id)}/firewall`,
        {
          method: "PATCH",
          body: { ...firewallForm, expectedRevision: firewallGate.configRevision },
        },
      );
      setFirewallOpen(false);
      setFirewallGate(undefined);
      await topology.reload();
      toast.success("Site VPN firewall policy updated.");
    } catch (error) {
      toast.errorFrom(error, "Unable to update Site VPN firewall.");
    } finally {
      setWorking(false);
    }
  }

  function editGateRouting(gate: GateResource) {
    setRoutingGate(gate);
    setRoutingForm({
      mode: gate.routeAdvertisementMode === "BGP" ? "BGP" : "Manual",
      localAsn: gate.bgpLocalAsn ? String(gate.bgpLocalAsn) : "",
      routerAddress: gate.bgpRouterAddress ?? "",
      routerAsn: gate.bgpRouterAsn ? String(gate.bgpRouterAsn) : "",
      sourceAddress: gate.bgpSourceAddress ?? gate.lanAddresses?.[0] ?? "",
      holdTimeSeconds: String(gate.bgpHoldTimeSeconds ?? 90),
    });
    setRoutingErrors({});
    setRoutingOpen(true);
  }

  async function saveGateRouting(event: FormEvent) {
    event.preventDefault();
    if (!routingGate) return;
    const errors = validateRoutingForm(routingForm);
    setRoutingErrors(errors);
    if (hasFormErrors(errors)) return;
    setWorking(true);
    try {
      const body =
        routingForm.mode === "BGP"
          ? {
              mode: "BGP",
              localAsn: Number(routingForm.localAsn),
              routerAddress: routingForm.routerAddress.trim(),
              routerAsn: Number(routingForm.routerAsn),
              sourceAddress: routingForm.sourceAddress.trim() || undefined,
              holdTimeSeconds: Number(routingForm.holdTimeSeconds || "90"),
            }
          : { mode: "Manual" };
      await apiRequest(
        `${root}/gates/${encodeURIComponent(routingGate.id)}/routing`,
        {
          method: "PATCH",
          body,
        },
      );
      setRoutingOpen(false);
      setRoutingGate(undefined);
      await topology.reload();
      toast.success(
        routingForm.mode === "BGP"
          ? "BGP route advertisement enabled."
          : "Site VPN routing changed to manual static routes.",
      );
    } catch (error) {
      toast.errorFrom(error, "Unable to update Site VPN routing.");
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
      toast.success(`Network ${network.name} deleted.`);
    } catch (error) {
      toast.errorFrom(error, "Unable to delete Network.");
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
      toast.success(`Site VPN ${gate.name} deletion requested.`);
    } catch (error) {
      toast.errorFrom(error, "Unable to delete Gate.");
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
          confirmDescription="A Network can only be deleted after every application, Site VPN and Device VPN access has been disconnected."
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
      routing: gate.routeAdvertisementMode === "BGP" ? (
        <div>
          <strong className="block text-[12px] text-[#137A4A]">BGP</strong>
          <span className="text-[11px] text-[#718096]">
            AS{gate.bgpLocalAsn ?? "?"} → AS{gate.bgpRouterAsn ?? "?"}
          </span>
        </div>
      ) : (
        <span className="text-xs text-[#718096]">Manual</span>
      ),
      networks: gate.networks?.length ?? 0,
      lastSeen: formatDate(gate.lastSeenAt),
      actions: (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" disabled={working || Boolean(gate.revokedAt)} onClick={() => editGateFirewall(gate)}>
            Firewall
          </Button>
          <Button size="sm" variant="ghost" disabled={working || Boolean(gate.revokedAt)} onClick={() => editGateRouting(gate)}>
            Routing
          </Button>
          <Button size="sm" variant="ghost" disabled={working || Boolean(gate.revokedAt)} onClick={() => void rotateEnrollment(gate)}>
            Re-enroll
          </Button>
          <ConfirmActionButton
            size="sm"
            triggerVariant="ghost"
            disabled={working || Boolean(gate.revokedAt)}
            confirmTitle="Delete Site VPN?"
            confirmDescription="The agent token is invalidated immediately. The Site VPN record is permanently deleted after its RP-side VPN stack and private key secret are removed."
            confirmLabel="Delete Site VPN"
            onConfirm={() => deleteGate(gate)}
          >
            Delete
          </ConfirmActionButton>
        </div>
      ),
    },
  }));

  const deviceRows = items<VpnDevice>(devices.data).map(device => ({
    key: `device:${device.id}`,
    cells: {
      gate: <div><strong className="block text-[13px]">{device.name}</strong><code className="text-xs text-[#718096]">{device.address ?? `${device.assignedAddress}/32`}</code></div>,
      status: <StatusBadge tone={statusTone(device.status)}>{device.status}</StatusBadge>,
      routing: <StatusBadge tone="success">Device VPN</StatusBadge>,
      networks: device.networks.map(network=>network.name).join(", ") || "—",
      lastSeen: formatDate(device.lastSeenAt),
      actions: <div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={()=>setDeviceEditRequest(current=>({id:device.id,nonce:(current?.nonce??0)+1}))}>Edit access</Button><ConfirmActionButton size="sm" triggerVariant="ghost" confirmTitle={`Revoke Device VPN ${device.name}?`} confirmDescription="The WireGuard peer and its access will be revoked." confirmLabel="Revoke" onConfirm={async()=>{await apiRequest(`${root}/device-vpn/devices/${encodeURIComponent(device.id)}`,{method:"DELETE"});await devices.reload();setDeviceRefreshId(value=>value+1);}}><TrashIcon size={14}/> Revoke</ConfirmActionButton></div>,
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
        method:
          gate.routeAdvertisementMode === "BGP" ? (
            <StatusBadge tone="success">BGP</StatusBadge>
          ) : (
            <StatusBadge tone="neutral">Manual</StatusBadge>
          ),
        nextHop:
          gate.routeAdvertisementMode === "BGP" ? (
            <code className="text-xs">{gate.bgpRouterAddress || "BGP peer not configured"}</code>
          ) : gate.lanAddresses?.[0] ? (
            <code className="text-xs">{gate.lanAddresses[0]}</code>
          ) : (
            <span className="text-xs text-[#9A6700]">Awaiting LAN address</span>
          ),
        route:
          gate.routeAdvertisementMode === "BGP" ? (
            <code className="break-all text-[11px]">
              advertise {link.network.cidr} to {gate.bgpRouterAddress || "peer"} (AS{gate.bgpRouterAsn ?? "?"})
            </code>
          ) : gate.lanAddresses?.[0] ? (
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
        description="Connect applications across App Groups, expose selected Networks to a whole site with Site VPN, or connect individual devices with Device VPN."
        actions={
          <>
            <Button onClick={() => setNetworkOpen(true)}>
              <PlusIcon size={15} /> Create Network
            </Button>

          </>
        }
      />
      <NetworkingTabs tenantId={tenantId} active="networking" />

      {topology.error ? (
        <div className="mb-5">
          <Callout tone="danger" title="Networking topology unavailable">
            {topology.error instanceof Error ? topology.error.message : "The topology API could not be loaded."}
          </Callout>
        </div>
      ) : null}

      <Callout title="How to connect">
        Applications and Site VPN instances meet through a tenant Network; they are never linked directly. Connect both nodes to the same Network. Application connections update desired state and require Deploy changes in that App Group; Site VPN routes reconcile automatically.
      </Callout>

      {topology.data && topology.data.networks.length === 0 ? (
        <div className="mt-4">
          <Callout tone="warning" title="Create a Network before connecting an app and Site VPN">
            This tenant has no Network yet. Create one first (the CIDR can be allocated automatically), then connect the Application and Site VPN to that same Network.
            <div className="mt-3"><Button size="sm" onClick={() => setNetworkOpen(true)}>Create Network</Button></div>
          </Callout>
        </div>
      ) : null}
      {connectionGuidance ? (
        <div className="mt-4">
          <Callout tone="warning" title="Connection needs a Network">{connectionGuidance}</Callout>
        </div>
      ) : null}

      <Card className="mt-5 overflow-hidden">
        {topology.data ? (
          <TenantNetworkingGraph
            topology={topology.data}
            working={working}
            onConnect={submitConnection}
            onDisconnect={disconnectEdge}
            onDeleteGate={deleteGate}
            onAddVpn={kind=>{if(kind==="site"){setEnrollment(undefined);setGateOpen(true);}else setDeviceCreateRequestId(id=>id+1);}}
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
            <h2 className="font-semibold text-[#172033]">VPN connections</h2>
            <p className="mt-1 text-xs text-[#718096]">Site VPN connects entire LANs; Device VPN connects individual WireGuard clients to selected tenant Networks.</p>
          </div>
          <DataTable
            embedded
            loading={topology.loading}
            columns={[
              { key: "gate", label: "Gate" },
              { key: "status", label: "Status" },
              { key: "routing", label: "Type" },
              { key: "networks", label: "Networks" },
              { key: "lastSeen", label: "Last seen" },
              { key: "actions", label: "" },
            ]}
            rows={[...gateRows.map(row=>({...row,cells:{...row.cells,routing:<StatusBadge tone="info">Site VPN</StatusBadge>}})),...deviceRows]}
            empty={<EmptyState icon={<ServerIcon />} title="No VPN connections" description="Use Add VPN in Network Control Center to add Site VPN or Device VPN." />}
          />
        </Card>
      </div>

      <DeviceVpnPanel
        tenantId={tenantId}
        networks={topology.data?.networks ?? []}
        showTable={false}
        createRequestId={deviceCreateRequestId}
        editRequest={deviceEditRequest}
        refreshId={deviceRefreshId}
        onChanged={()=>void devices.reload()}
      />

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-[#E1E7F0] px-5 py-4">
          <h2 className="font-semibold text-[#172033]">Site VPN route advertisement</h2>
          <p className="mt-1 text-xs text-[#718096]">
            Manual Gates require static routes on the LAN router. BGP Gates advertise attached RP Network CIDRs automatically and never import LAN routes into ResourcePortal.
          </p>
        </div>
        <DataTable
          embedded
          loading={topology.loading}
          columns={[
            { key: "gate", label: "Gate" },
            { key: "network", label: "RP Network" },
            { key: "method", label: "Method" },
            { key: "nextHop", label: "Router / next-hop" },
            { key: "route", label: "Route" },
          ]}
          rows={routeRows}
          empty={<EmptyState icon={<NetworkIcon />} title="No exported routes" description="Connect a Site VPN node to a Network node." />}
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
          <Field label="Name" required hint="Lowercase letters, numbers and hyphens." error={networkErrors.name}>
            <TextInput required aria-required="true" value={networkForm.name} onChange={(event) => { setNetworkForm({ ...networkForm, name: event.target.value }); setNetworkErrors((current) => ({ ...current, name: undefined })); }} placeholder="backend" />
          </Field>
          <Field label="CIDR" hint="Optional private IPv4 CIDR (/16 through /28). Default pool: automatically allocated." error={networkErrors.cidr}>
            <TextInput value={networkForm.cidr} onChange={(event) => { setNetworkForm({ ...networkForm, cidr: event.target.value }); setNetworkErrors((current) => ({ ...current, cidr: undefined })); }} placeholder="10.240.20.0/24" />
          </Field>
          <Field label="Description" error={networkErrors.description}>
            <TextInput value={networkForm.description} onChange={(event) => { setNetworkForm({ ...networkForm, description: event.target.value }); setNetworkErrors((current) => ({ ...current, description: undefined })); }} placeholder="Shared backend connectivity" />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={gateOpen}
        onClose={() => { if (!working) { setGateOpen(false); setEnrollment(undefined); } }}
        title={enrollment ? "Install Site VPN" : "Add Site VPN"}
        description={enrollment ? "Run this one-time command on the Linux host that will route your LAN into selected RP Networks." : "Create a Site VPN gateway for an entire LAN."}
        actions={
          enrollment ? (
            <Button variant="primary" onClick={() => { setGateOpen(false); setEnrollment(undefined); }}>Done</Button>
          ) : (
            <>
              <Button disabled={working} onClick={() => setGateOpen(false)}>Cancel</Button>
              <Button variant="primary" type="submit" form="create-gate-form" disabled={working || !gateForm.name.trim()}>
                {working ? "Creating…" : "Create Site VPN"}
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
                <pre className="m-0 min-w-0 flex-1 select-all whitespace-pre-wrap break-all bg-transparent p-0 text-xs leading-5 text-white"><code>{command}</code></pre>
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
            <Field label="Name" required error={gateErrors.name}>
              <TextInput required aria-required="true" value={gateForm.name} onChange={(event) => { setGateForm({ ...gateForm, name: event.target.value }); setGateErrors((current) => ({ ...current, name: undefined })); }} placeholder="office-site-vpn" />
            </Field>
            <Field label="Description" error={gateErrors.description}>
              <TextInput value={gateForm.description} onChange={(event) => { setGateForm({ ...gateForm, description: event.target.value }); setGateErrors((current) => ({ ...current, description: undefined })); }} placeholder="Office Site VPN gateway" />
            </Field>
          </form>
        )}
      </Dialog>

      <Dialog
        open={firewallOpen}
        onClose={() => { if (!working) { setFirewallOpen(false); setFirewallGate(undefined); } }}
        title={firewallGate ? `Firewall · ${firewallGate.name}` : "Site VPN Firewall"}
        description="Choose which side may initiate new connections. Established reply traffic is still permitted."
        actions={
          <>
            <Button disabled={working} onClick={() => { setFirewallOpen(false); setFirewallGate(undefined); }}>Cancel</Button>
            <Button variant="primary" type="submit" form="gate-firewall-form" disabled={working || !firewallGate || (firewallForm.allowRpToLan && firewallGate.agentVersion !== "gate-shell-v3")}>
              {working ? "Saving…" : "Save firewall"}
            </Button>
          </>
        }
      >
        <form id="gate-firewall-form" className="space-y-4" onSubmit={(event) => void saveGateFirewall(event)}>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-[#D7E0EC] p-4">
            <span>
              <strong className="block text-sm text-[#172033]">LAN → RP</strong>
              <span className="block text-xs text-[#718096]">Allow LAN devices to initiate connections to Networks attached to this Site VPN.</span>
            </span>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-[#137A4A]" checked={firewallForm.allowLanToRp}
              onChange={(event) => setFirewallForm(current => ({ ...current, allowLanToRp: event.target.checked }))} />
          </label>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-[#D7E0EC] p-4">
            <span>
              <strong className="block text-sm text-[#172033]">RP → LAN</strong>
              <span className="block text-xs text-[#718096]">Allow attached ResourcePortal Networks to initiate connections to this Site VPN's reported LAN CIDRs.</span>
            </span>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-[#137A4A]" checked={firewallForm.allowRpToLan}
              onChange={(event) => setFirewallForm(current => ({ ...current, allowRpToLan: event.target.checked }))} />
          </label>
          {firewallForm.allowRpToLan && firewallGate?.agentVersion !== "gate-shell-v3" ? (
            <Callout tone="warning" title="Site VPN agent upgrade required">
              Re-enroll and reinstall the Site VPN agent to activate RP → LAN. The agent must report gate-shell-v3.
            </Callout>
          ) : null}
          <Callout title="Routing prerequisite">
            Site VPN policy controls tunnel forwarding, not application routing. RP → LAN also needs a valid route from each RP application to the Gate gateway and the Gate LAN host must be able to reach destination devices. No mDNS or discovery relay is enabled.
          </Callout>
        </form>
      </Dialog>

      <Dialog
        open={routingOpen}
        onClose={() => {
          if (!working) {
            setRoutingOpen(false);
            setRoutingGate(undefined);
          }
        }}
        title={routingGate ? `Route advertisement · ${routingGate.name}` : "Route advertisement"}
        description="Choose how the LAN router learns routes to Networks attached to this Site VPN."
        actions={
          <>
            <Button
              disabled={working}
              onClick={() => {
                setRoutingOpen(false);
                setRoutingGate(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="gate-routing-form"
              disabled={
                working ||
                !routingGate ||
                (routingForm.mode === "BGP" &&
                  (!routingForm.localAsn ||
                    !routingForm.routerAddress.trim() ||
                    !routingForm.routerAsn ||
                    !routingForm.holdTimeSeconds))
              }
            >
              {working ? "Saving…" : "Save routing"}
            </Button>
          </>
        }
      >
        <form
          id="gate-routing-form"
          className="space-y-4"
          onSubmit={(event) => void saveGateRouting(event)}
        >
          <Field label="Route advertisement" required>
            <Select
              value={routingForm.mode}
              onChange={(event) =>
                setRoutingForm({
                  ...routingForm,
                  mode: event.target.value as "Manual" | "BGP",
                })
              }
            >
              <option value="Manual">Manual static routes</option>
              <option value="BGP">BGP (automatic)</option>
            </Select>
          </Field>

          {routingForm.mode === "BGP" ? (
            <>
              <Callout title="Export-only eBGP">
                ResourcePortal advertises only CIDRs from this Gate&apos;s active Network attachments.
                Routes received from the LAN router are denied and are never imported into ResourcePortal.
              </Callout>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Site VPN ASN" required hint="Private ASN is recommended, for example 65050." error={routingErrors.localAsn}>
                  <TextInput
                    type="number"
                    min={1}
                    max={4294967295}
                    required
                    value={routingForm.localAsn}
                    onChange={(event) => {
                      setRoutingForm({ ...routingForm, localAsn: event.target.value });
                      setRoutingErrors((current) => ({ ...current, localAsn: undefined, routerAsn: undefined }));
                    }}
                    placeholder="65050"
                  />
                </Field>
                <Field label="Router ASN" required error={routingErrors.routerAsn}>
                  <TextInput
                    type="number"
                    min={1}
                    max={4294967295}
                    required
                    value={routingForm.routerAsn}
                    onChange={(event) => {
                      setRoutingForm({ ...routingForm, routerAsn: event.target.value });
                      setRoutingErrors((current) => ({ ...current, routerAsn: undefined }));
                    }}
                    placeholder="65001"
                  />
                </Field>
                <Field label="Router IP" required hint="Must be inside a LAN CIDR reported by this Gate." error={routingErrors.routerAddress}>
                  <TextInput
                    required
                    value={routingForm.routerAddress}
                    onChange={(event) => {
                      setRoutingForm({ ...routingForm, routerAddress: event.target.value });
                      setRoutingErrors((current) => ({ ...current, routerAddress: undefined }));
                    }}
                    placeholder="192.168.1.1"
                  />
                </Field>
                <Field label="Source IP" hint="Optional. Must be a LAN address reported by this Gate." error={routingErrors.sourceAddress}>
                  <TextInput
                    value={routingForm.sourceAddress}
                    onChange={(event) => {
                      setRoutingForm({ ...routingForm, sourceAddress: event.target.value });
                      setRoutingErrors((current) => ({ ...current, sourceAddress: undefined }));
                    }}
                    placeholder={routingGate?.lanAddresses?.[0] || "192.168.1.50"}
                  />
                </Field>
                <Field label="Hold time" required hint="BGP hold timer in seconds." error={routingErrors.holdTimeSeconds}>
                  <TextInput
                    type="number"
                    min={9}
                    max={65535}
                    required
                    value={routingForm.holdTimeSeconds}
                    onChange={(event) => {
                      setRoutingForm({ ...routingForm, holdTimeSeconds: event.target.value });
                      setRoutingErrors((current) => ({ ...current, holdTimeSeconds: undefined }));
                    }}
                  />
                </Field>
              </div>
              <div className="rounded-lg border border-[#D7E0EC] bg-[#F8FAFD] p-4">
                <p className="text-xs font-semibold uppercase tracking-[.04em] text-[#526070]">
                  Advertised prefixes
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(routingGate?.networks ?? []).length ? (
                    routingGate?.networks.map((link) => (
                      <code
                        key={link.network.id}
                        className="rounded bg-white px-2 py-1 text-xs text-[#172033] ring-1 ring-[#D7E0EC]"
                      >
                        {link.network.cidr}
                      </code>
                    ))
                  ) : (
                    <span className="text-xs text-[#718096]">
                      None. Attach this Site VPN to a Network to advertise a prefix.
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <Callout title="Manual static routes">
              The LAN router must have a static route for each attached RP Network CIDR via this Gate&apos;s LAN address.
            </Callout>
          )}
        </form>
      </Dialog>
    </main>
  );
}