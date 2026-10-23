import { useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import {
  Button, Callout, Card, Field, Select, StatusBadge, TextInput,
} from "../components/design-system";
import { useApi } from "../hooks/use-api";
import { toast } from "../components/toast";
import type { Topology } from "./tenant-networking-graph";

type RemoteAttachment = {
  id: string;
  singleAppId: string;
  networkId: string;
  gateId: string;
  lanInterface: string;
  lanCidr: string;
  macAddress: string;
  status: string;
  dhcpAddress?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
};

type AvailableApp = { id: string; label: string; networkIds: string[] };

export function availableRemoteLanApps(topology: Topology): AvailableApp[] {
  return topology.appGroups.flatMap(group =>
    group.singleApps.filter(app => app.networkAttachments.length > 0).map(app => ({
      id: app.id,
      label: group.name + " / " + app.name,
      networkIds: app.networkAttachments.map(attachment => attachment.networkId),
    })),
  );
}

export function RemoteLanAttachmentsPanel({
  tenantId, topology,
}: {
  tenantId: string; topology: Topology | undefined;
}) {
  const root = "/api/tenants/" + encodeURIComponent(tenantId) + "/networking/lan-attachments";
  const attachments = useApi<RemoteAttachment[]>(root);
  const rows = Array.isArray(attachments.data) ? attachments.data : [];
  const [singleAppId, setApp] = useState("");
  const [networkId, setNetwork] = useState("");
  const [gateId, setGate] = useState("");
  const [lanInterface, setLanInterface] = useState("");
  const [lanCidr, setLanCidr] = useState("");
  const [working, setWorking] = useState(false);
  const apps = topology ? availableRemoteLanApps(topology) : [];
  const app = apps.find(item => item.id === singleAppId);
  const networks = (topology?.networks ?? []).filter(item =>
    item.status === "Ready" && (app?.networkIds.includes(item.id) ?? false));
  const selectedGate = topology?.gates.find(gate => gate.id === gateId);
  const alreadyAttached = new Set(rows
    .filter(item => item.status !== "Revoked")
    .map(item => item.singleAppId));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!singleAppId || !networkId || !gateId || !lanInterface || !lanCidr ||
        !app?.networkIds.includes(networkId) || alreadyAttached.has(singleAppId)) return;
    setWorking(true);
    try {
      await apiRequest(root, {
        method: "POST",
        body: { singleAppId, networkId, gateId, lanInterface: lanInterface.trim(),
          lanCidr: lanCidr.trim() },
      });
      await attachments.reload();
      setApp("");
      setNetwork("");
      setLanInterface("");
      setLanCidr("");
      toast.success("LAN Attachment created. DHCP activation requires verified Gate and node dataplane.");
    } catch (error) {
      toast.errorFrom(error, "Unable to create LAN Attachment");
    } finally {
      setWorking(false);
    }
  }

  async function revoke(id: string) {
    setWorking(true);
    try {
      await apiRequest(root + "/" + encodeURIComponent(id), { method: "DELETE" });
      await attachments.reload();
      toast.success("LAN Attachment revocation requested; cleanup remains tracked until confirmed.");
    } catch (error) {
      toast.errorFrom(error, "Unable to revoke LAN Attachment");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="mt-5 p-5">
      <h2 className="text-base font-semibold text-[#172033]">LAN Attachments</h2>
      <p className="mt-1 text-sm text-[#718096]">
        Attach one RP application to the selected customer's Ethernet LAN using RP Gate.
        Its dedicated interface and MAC receive an address from the existing LAN DHCP server.
        RP remains hosted on your infrastructure.
      </p>
      <Callout tone="warning" title="Dedicated LAN port required">
        Select an unnumbered physical Ethernet interface or isolated VLAN on the remote Gate.
        Never select the Gate's management interface, a Wi-Fi client interface or an existing bridge.
        Access stays pending until the Gate and application prove the L2 link and DHCP lease.
      </Callout>
      {attachments.error ? (
        <Callout tone="danger" title="LAN Attachments unavailable">
          {attachments.error instanceof Error ? attachments.error.message : "Unable to load attachments"}
        </Callout>
      ) : null}
      <form onSubmit={event => void create(event)} className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="Application">
          <Select value={singleAppId} onChange={event => {
            setApp(event.target.value);
            setNetwork("");
          }} required>
            <option value="">Choose one application</option>
            {apps.filter(item => !alreadyAttached.has(item.id)).map(item => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Application Network">
          <Select value={networkId} onChange={event => setNetwork(event.target.value)} required>
            <option value="">Choose its attached Network</option>
            {networks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="RP Gate">
          <Select value={gateId} onChange={event => setGate(event.target.value)} required>
            <option value="">Choose a Gate</option>
            {(topology?.gates ?? []).filter(item => !item.revokedAt).map(item => (
              <option key={item.id} value={item.id}>{item.name} ({item.status})</option>
            ))}
          </Select>
        </Field>
        <Field label="Dedicated Gate LAN interface">
          <TextInput required value={lanInterface} onChange={event => setLanInterface(event.target.value)}
            placeholder="eth1 or eth0.100" />
        </Field>
        <Field label="Expected customer DHCP subnet">
          <TextInput required value={lanCidr} onChange={event => setLanCidr(event.target.value)}
            placeholder="192.168.50.0/24" />
        </Field>
        <div className="flex items-end">
          <Button disabled={working || !selectedGate || !networks.some(item => item.id === networkId) ||
            !singleAppId || alreadyAttached.has(singleAppId)} type="submit">
            Create LAN Attachment
          </Button>
        </div>
      </form>
      <div className="mt-5 space-y-3" aria-label="Existing LAN Attachments">
        {rows.length === 0 ? (
          <p className="text-sm text-[#718096]">No LAN Attachments configured.</p>
        ) : rows.map(item => (
          <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E1E7F0] pt-3">
            <div className="text-sm">
              <strong>{apps.find(app => app.id === item.singleAppId)?.label ?? item.singleAppId}</strong>
              <span className="ml-2">{topology?.gates.find(gate => gate.id === item.gateId)?.name ?? item.gateId}</span>
              <div className="text-xs text-[#718096]">
                {item.lanInterface} · {item.lanCidr} · MAC {item.macAddress} · DHCP {item.dhcpAddress ?? "awaiting lease"}
              </div>
              {item.lastError ? <p className="text-xs text-red-700">{item.lastError}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge tone={item.status === "Active" ? "success" : item.status === "Revoking" ? "danger" : "info"}>
                {item.status}
              </StatusBadge>
              {item.status !== "Revoking" && item.status !== "Revoked" ? (
                <Button size="sm" disabled={working} onClick={() => void revoke(item.id)}>Revoke</Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
