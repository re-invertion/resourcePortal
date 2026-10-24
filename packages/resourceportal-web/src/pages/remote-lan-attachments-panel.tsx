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
  uplinkMode?: "DedicatedUnnumbered" | "ManagedSharedUplink";
  addressMode?: "DHCP" | "Static";
  staticAddress?: string | null;
  staticGateway?: string | null;
  configurationRevision?: number;
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
  const [uplinkMode,setUplinkMode] = useState<"DedicatedUnnumbered"|"ManagedSharedUplink">("DedicatedUnnumbered");
  const [addressMode,setAddressMode] = useState<"DHCP"|"Static">("DHCP");
  const [staticAddress,setStaticAddress] = useState("");
  const [staticGateway,setStaticGateway] = useState("");
  const [editId,setEditId] = useState("");
  const [editAddressMode,setEditAddressMode] = useState<"DHCP"|"Static">("DHCP");
  const [editIp,setEditIp] = useState("");
  const [editGateway,setEditGateway] = useState("");
  const [working, setWorking] = useState(false);
  const apps = topology ? availableRemoteLanApps(topology) : [];
  const app = apps.find(item => item.id === singleAppId);
  const networks = (topology?.networks ?? []).filter(item =>
    item.status === "Ready" && (app?.networkIds.includes(item.id) ?? false));
  const selectedGate = topology?.gates.find(gate => gate.id === gateId);
  const rawObserved=selectedGate?.observedLan;
  const reportedAt=Date.parse(selectedGate?.observedLanAt ?? "");
  const observed=rawObserved?.state==="Ready" && rawObserved.protocol===1 &&
    rawObserved.gateId===gateId &&
    Number.isFinite(reportedAt) && Date.now()-reportedAt>=0 &&
    Date.now()-reportedAt<=60_000 ? rawObserved : null;
  const effectiveInterface=uplinkMode==="ManagedSharedUplink"
    ? observed?.physicalInterface??"" : lanInterface;
  const effectiveLanCidr=uplinkMode==="ManagedSharedUplink"
    ? observed?.networkCidr??"" : lanCidr;
  const effectiveGateway=staticGateway.trim() || observed?.gateway || "";
  const alreadyAttached = new Set(rows
    .filter(item => item.status !== "Revoked")
    .map(item => item.singleAppId));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!singleAppId || !networkId || !gateId || !effectiveInterface || !effectiveLanCidr ||
        (uplinkMode==="ManagedSharedUplink" && !observed) ||
        (addressMode==="Static" && (!staticAddress || !effectiveGateway)) ||
        !app?.networkIds.includes(networkId) || alreadyAttached.has(singleAppId)) return;
    setWorking(true);
    try {
      await apiRequest(root, {
        method: "POST",
        body: { singleAppId, networkId, gateId, lanInterface: effectiveInterface.trim(),
          lanCidr: effectiveLanCidr.trim(),
          ...(uplinkMode==="ManagedSharedUplink" ? {
            uplinkMode,addressMode,
            ...(addressMode==="Static" ? {
              staticAddress:staticAddress.trim(),staticGateway:effectiveGateway
            } : {})
          } : {})
        },
      });
      await attachments.reload();
      setApp("");
      setNetwork("");
      setLanInterface("");
      setLanCidr("");
      setAddressMode("DHCP");setStaticAddress("");setStaticGateway("");
      toast.success("LAN Attachment created. DHCP activation requires verified Gate and node dataplane.");
    } catch (error) {
      toast.errorFrom(error, "Unable to create LAN Attachment");
    } finally {
      setWorking(false);
    }
  }

  async function updateAddressing(id:string) {
    setWorking(true);
    try {
      await apiRequest(root+"/"+encodeURIComponent(id)+"/addressing",{
        method:"PATCH",
        body:{addressMode:editAddressMode,
          ...(editAddressMode==="Static" ? {
            staticAddress:editIp.trim(),staticGateway:editGateway.trim()
          }: {})
        }
      });
      await attachments.reload();
      setEditId("");setEditIp("");setEditGateway("");
      toast.success("Address configuration updated; prior L2 grant will be revoked before re-provisioning.");
    } catch(error) {
      toast.errorFrom(error,"Unable to update LAN addressing");
    } finally { setWorking(false); }
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
      {uplinkMode==="DedicatedUnnumbered" ? (
        <Callout tone="warning" title="Dedicated LAN port required">
          Select an unnumbered physical Ethernet interface or isolated VLAN on the remote Gate.
          Never select the Gate's management interface, a Wi-Fi client interface or an existing bridge.
          Access stays pending until the Gate and application prove the encrypted L2 link.
        </Callout>
      ) : (
        <Callout tone={observed ? "info" : "warning"} title="Managed shared Gate uplink">
          {observed ? (
            <>Gate-confirmed customer LAN: {observed.networkCidr}, bridge {observed.bridge},
            physical uplink {observed.physicalInterface}, detected gateway {observed.gateway}.
            Its management IP stays on the persistent bridge.</>
          ) : (
            <>No recent verified LAN observation. Configure the Gate's managed uplink
            with the installed Gate tool and wait for its authenticated heartbeat
            before creating an attachment.</>
          )}
        </Callout>
      )}
      {attachments.error ? (
        <Callout tone="danger" title="LAN Attachments unavailable">
          {attachments.error instanceof Error ? attachments.error.message : "Unable to load attachments"}
        </Callout>
      ) : null}
      <form onSubmit={event => void create(event)} className="mt-4 grid gap-3 md:grid-cols-2">
        <Field label="LAN uplink mode">
          <Select value={uplinkMode} onChange={event=>{
            setUplinkMode(event.target.value as "DedicatedUnnumbered"|"ManagedSharedUplink");
            setAddressMode("DHCP");setStaticAddress("");setStaticGateway("");
          }}>
            <option value="DedicatedUnnumbered">Dedicated unnumbered port</option>
            <option value="ManagedSharedUplink">Managed shared uplink (existing Gate LAN)</option>
          </Select>
        </Field>
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
        {uplinkMode==="DedicatedUnnumbered" ? (
          <>
            <Field label="Dedicated Gate LAN interface">
              <TextInput required value={lanInterface} onChange={event => setLanInterface(event.target.value)}
                placeholder="eth1 or eth0.100" />
            </Field>
            <Field label="Expected customer DHCP subnet">
              <TextInput required value={lanCidr} onChange={event => setLanCidr(event.target.value)}
                placeholder="192.168.50.0/24" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Verified Gate LAN">
              <TextInput value={observed?.networkCidr ?? "No verified LAN"}
                disabled />
            </Field>
            <Field label="Physical management uplink">
              <TextInput value={observed?.physicalInterface ?? "Unavailable"}
                disabled />
            </Field>
            <Field label="Address assignment">
              <Select value={addressMode} onChange={event=>{
                setAddressMode(event.target.value as "DHCP"|"Static");
                setStaticAddress("");
                setStaticGateway(observed?.gateway ?? "");
              }}>
                <option value="DHCP">DHCP from customer's LAN</option>
                <option value="Static">Static IPv4</option>
              </Select>
            </Field>
            {addressMode==="Static" ? (
              <>
                <Field label="Static IPv4 address/prefix">
                  <TextInput required value={staticAddress}
                    onChange={event=>setStaticAddress(event.target.value)}
                    placeholder="192.168.50.40/24" />
                </Field>
                <Field label="Static IPv4 gateway">
                  <TextInput required value={staticGateway}
                    onChange={event=>setStaticGateway(event.target.value)}
                    placeholder={observed?.gateway ?? "192.168.50.1"} />
                </Field>
              </>
            ) : null}
          </>
        )}
        <div className="flex items-end">
          <Button disabled={working || !selectedGate || !networks.some(item => item.id === networkId) ||
            !singleAppId || alreadyAttached.has(singleAppId) ||
            (uplinkMode==="ManagedSharedUplink" && !observed) ||
            (addressMode==="Static" && (!staticAddress || !effectiveGateway))} type="submit">
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
                {item.lanInterface} · {item.lanCidr} · MAC {item.macAddress} ·
                {item.addressMode==="Static" ? (
                  <> Static {item.staticAddress ?? "unassigned"} via {item.staticGateway ?? "no gateway"}</>
                ) : (<> DHCP {item.dhcpAddress ?? "awaiting lease"}</>)}
                {item.uplinkMode==="ManagedSharedUplink" ? <> · Managed bridge</> : null}
              </div>
              {item.lastError ? <p className="text-xs text-red-700">{item.lastError}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge tone={item.status === "Active" ? "success" : item.status === "Revoking" ? "danger" : "info"}>
                {item.status}
              </StatusBadge>
              {item.uplinkMode==="ManagedSharedUplink" &&
               item.status!=="Revoking" && item.status!=="Revoked" ? (
                <Button size="sm" disabled={working} onClick={()=>{
                  setEditId(item.id);
                  setEditAddressMode(item.addressMode??"DHCP");
                  setEditIp(item.staticAddress??"");
                  setEditGateway(item.staticGateway??"");
                }}>Edit IP</Button>
              ) : null}
              {item.status !== "Revoking" && item.status !== "Revoked" ? (
                <Button size="sm" disabled={working} onClick={() => void revoke(item.id)}>Revoke</Button>
              ) : null}
            </div>
            {editId===item.id ? (
              <div className="mt-3 grid w-full gap-3 rounded-lg border border-[#D7E0EC] p-3 md:grid-cols-2">
                <Field label="Edit address assignment">
                  <Select value={editAddressMode} onChange={event=>
                    setEditAddressMode(event.target.value as "DHCP"|"Static")}>
                    <option value="DHCP">DHCP</option>
                    <option value="Static">Static IPv4</option>
                  </Select>
                </Field>
                {editAddressMode==="Static" ? (
                  <>
                    <Field label="Edit static IPv4/prefix">
                      <TextInput value={editIp} onChange={event=>setEditIp(event.target.value)}
                        placeholder="192.168.50.40/24"/>
                    </Field>
                    <Field label="Edit static gateway">
                      <TextInput value={editGateway} onChange={event=>setEditGateway(event.target.value)}
                        placeholder="192.168.50.1"/>
                    </Field>
                  </>
                ) : null}
                <div className="flex items-end gap-2">
                  <Button size="sm" disabled={working ||
                    (editAddressMode==="Static" && (!editIp || !editGateway))}
                    onClick={()=>void updateAddressing(item.id)}>Save IP settings</Button>
                  <Button size="sm" disabled={working} onClick={()=>setEditId("")}>Cancel</Button>
                </div>
              </div>
            ):null}
          </div>
        ))}
      </div>
    </Card>
  );
}
