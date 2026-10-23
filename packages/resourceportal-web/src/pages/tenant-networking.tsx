import { useState, type FormEvent } from "react";
import type { Connection, Edge } from "@xyflow/react";
import { apiRequest } from "../api/client";
import {
  Button, Callout, Card, ConfirmActionButton, Dialog, Field, PageHeader,
  Select, StatusBadge, TextInput, statusTone,
} from "../components/design-system";
import { formatDate, useApi } from "../hooks/use-api";
import { toast } from "../components/toast";
import { NetworkingTabs } from "../components/tenant-section-tabs";
import {
  TenantNetworkingGraph, type GateResource, type NetworkResource, type Topology,
} from "./tenant-networking-graph";
import { RemoteLanAttachmentsPanel } from "./remote-lan-attachments-panel";
import { DeviceVpnPanel } from "./device-vpn-panel";
import { hasFormErrors, validateGateForm, validateNetworkForm } from "./networking-form-validation";

type Operation={id:string;status:string;errorMessage?:string|null};
type Enrollment={
  enrollment:{token:string;expiresAt:string};gate?:GateResource;
};
function installerCommand(response:Enrollment) {
  if(typeof window==="undefined")return "";
  const api=window.location.origin+"/api";
  return "curl -fsSL "+window.location.origin+
    "/api/networking/gates/install.sh | sudo bash -s -- --url "+
    api+" --token '"+response.enrollment.token+"'";
}
async function operationResult(tenantId:string,operation:Operation) {
  let current=operation;
  for(let i=0;i<60&&!["Succeeded","Failed","RolledBack","RollbackFailed"].includes(current.status);i++){
    await new Promise(resolve=>setTimeout(resolve,300));
    current=await apiRequest<Operation>("/api/tenants/"+encodeURIComponent(tenantId)+
      "/operations/"+encodeURIComponent(operation.id));
  }
  if(current.status!=="Succeeded"&&current.status!=="RolledBack")
    throw new Error(current.errorMessage||"Application topology operation was not successful");
}

export function TenantNetworkingPage({tenantId}:{tenantId:string}) {
  const root="/api/tenants/"+encodeURIComponent(tenantId)+"/networking";
  const topology=useApi<Topology>(root+"/topology");
  const [working,setWorking]=useState(false);
  const [createNetworkOpen,setNetworkOpen]=useState(false);
  const [createGateOpen,setGateOpen]=useState(false);
  const [networkForm,setNetworkForm]=useState({name:"",description:"",cidr:""});
  const [networkErrors,setNetworkErrors]=useState<Record<string,string|undefined>>({});
  const [gateForm,setGateForm]=useState({name:"",description:""});
  const [gateErrors,setGateErrors]=useState<Record<string,string|undefined>>({});
  const [enrollment,setEnrollment]=useState<Enrollment>();
  const [attachApp,setAttachApp]=useState("");
  const [attachNetwork,setAttachNetwork]=useState("");
  const networks=topology.data?.networks??[];
  const gates=topology.data?.gates??[];
  const apps=topology.data?.appGroups.flatMap(group=>group.singleApps.map(app=>({
    id:app.id,label:group.name+" / "+app.name,
    networkIds:app.networkAttachments.map(link=>link.networkId),
  })))??[];

  async function createNetwork(event:FormEvent){
    event.preventDefault();
    const errors=validateNetworkForm(networkForm);
    setNetworkErrors(errors);
    if(hasFormErrors(errors))return;
    setWorking(true);
    try{
      await apiRequest(root+"/networks",{method:"POST",
        body:{name:networkForm.name.trim(),description:networkForm.description.trim()||undefined,
          cidr:networkForm.cidr.trim()||undefined}});
      await topology.reload();
      setNetworkForm({name:"",description:"",cidr:""});
      setNetworkErrors({});
      setNetworkOpen(false);
      toast.success("Network created.");
    }catch(error){toast.errorFrom(error,"Unable to create Network");}
    finally{setWorking(false);}
  }
  async function createGate(event:FormEvent){
    event.preventDefault();
    const errors=validateGateForm(gateForm);
    setGateErrors(errors);
    if(hasFormErrors(errors))return;
    setWorking(true);
    try{
      const response=await apiRequest<Enrollment>(root+"/gates",{method:"POST",
        body:{name:gateForm.name.trim(),description:gateForm.description.trim()||undefined}});
      setEnrollment(response);
      setGateForm({name:"",description:""});
      setGateErrors({});
      await topology.reload();
    }catch(error){toast.errorFrom(error,"Unable to create RP Gate");}
    finally{setWorking(false);}
  }
  async function addAppNetwork(appId:string,networkId:string){
    if(!appId||!networkId||!networks.some(network=>network.id===networkId))
      throw new Error("Invalid selected Network");
    const app=apps.find(value=>value.id===appId);
    if(!app||app.networkIds.includes(networkId))
      throw new Error("Application is already attached or no longer exists");
    const network=networks.find(value=>value.id===networkId)!;
    setWorking(true);
    try{
      const op=await apiRequest<Operation>(root+"/networks/"+encodeURIComponent(networkId)+"/attachments",{
        method:"POST",headers:{"idempotency-key":crypto.randomUUID()},
        body:{singleAppId:appId,expectedRevision:network.revision}});
      await operationResult(tenantId,op);
      await topology.reload();
      toast.success("Application attached. Deploy its App Group to apply the change.");
    }catch(error){toast.errorFrom(error,"Unable to attach application");}
    finally{setWorking(false);}
  }
  async function detachNetwork(edge:Edge){
    const attachmentId=edge.data?.attachmentId;
    const networkId=edge.data?.networkId;
    if(typeof attachmentId!=="string"||typeof networkId!=="string")return;
    setWorking(true);
    try{
      const network=networks.find(item=>item.id===networkId);
      const op=await apiRequest<Operation>(
        root+"/networks/"+encodeURIComponent(networkId)+"/attachments/"+
        encodeURIComponent(attachmentId),{
          method:"DELETE",headers:{"idempotency-key":crypto.randomUUID()},
          body:{expectedRevision:network?.revision},
        });
      await operationResult(tenantId,op);
      await topology.reload();
      toast.success("Application disconnected. Deploy its App Group to apply the change.");
    }catch(error){toast.errorFrom(error,"Unable to disconnect application");}
    finally{setWorking(false);}
  }
  async function deleteNetwork(network:NetworkResource){
    setWorking(true);
    try{
      await apiRequest(root+"/networks/"+encodeURIComponent(network.id),{
        method:"DELETE",body:{expectedRevision:network.revision}});
      await topology.reload();
      toast.success("Network deletion requested.");
    }catch(error){toast.errorFrom(error,"Unable to delete Network");}
    finally{setWorking(false);}
  }
  async function revokeGate(gate:GateResource){
    setWorking(true);
    try{
      await apiRequest(root+"/gates/"+encodeURIComponent(gate.id),{method:"DELETE"});
      await topology.reload();
      toast.success("RP Gate deletion requested; cleanup is tracked.");
    }catch(error){toast.errorFrom(error,"Unable to delete RP Gate");}
    finally{setWorking(false);}
  }
  async function reEnrollGate(gate:GateResource){
    setWorking(true);
    try{
      const response=await apiRequest<Enrollment>(root+"/gates/"+encodeURIComponent(gate.id)+
        "/enrollment",{method:"POST"});
      setEnrollment(response);
      setGateOpen(true);
    }catch(error){toast.errorFrom(error,"Unable to re-enroll RP Gate");}
    finally{setWorking(false);}
  }
  function submitGraphConnection(connection:Connection){
    const ids=[connection.source,connection.target];
    const app=ids.find(id=>id?.startsWith("app:"))?.slice(4);
    const network=ids.find(id=>id?.startsWith("network:"))?.slice(8);
    if(app&&network)void addAppNetwork(app,network);
  }
  return (
    <main>
      <PageHeader eyebrow="Tenant networking" title="Networking"
        description="Connect applications to private Networks, attach selected applications to customer Ethernet through RP Gate, and manage Device VPN."
        actions={<>
          <Button onClick={()=>setNetworkOpen(true)}>Create Network</Button>
          <Button onClick={()=>{setEnrollment(undefined);setGateOpen(true);}}>Add RP Gate</Button>
        </>}/>
      <NetworkingTabs tenantId={tenantId} active="networking"/>
      {topology.error?<Callout tone="danger" title="Networking unavailable">
        {topology.error instanceof Error?topology.error.message:"Unable to load topology"}
      </Callout>:null}

      <RemoteLanAttachmentsPanel tenantId={tenantId} topology={topology.data}/>
      {topology.data?<TenantNetworkingGraph topology={topology.data} working={working}
        onConnect={submitGraphConnection} onDisconnect={edge=>void detachNetwork(edge)}/>:null}
      <Card className="mt-5 p-5">
        <h2 className="text-base font-semibold">Application Network membership</h2>
        <p className="mb-3 text-sm text-[#718096]">
          Connect an RP application to one of its tenant Networks. LAN Attachment is a separate L2 grant.
        </p>
        <form className="grid gap-3 md:grid-cols-3" onSubmit={event=>{
          event.preventDefault();void addAppNetwork(attachApp,attachNetwork);
        }}>
          <Field label="Application"><Select value={attachApp} onChange={e=>setAttachApp(e.target.value)}>
            <option value="">Choose application</option>
            {apps.map(app=><option key={app.id} value={app.id}>{app.label}</option>)}
          </Select></Field>
          <Field label="Network"><Select value={attachNetwork} onChange={e=>setAttachNetwork(e.target.value)}>
            <option value="">Choose Network</option>
            {networks.filter(network=>!apps.find(app=>app.id===attachApp)?.networkIds.includes(network.id))
              .map(network=><option key={network.id} value={network.id}>{network.name}</option>)}
          </Select></Field>
          <div className="flex items-end"><Button type="submit" disabled={working||!attachApp||!attachNetwork}>
            Connect application</Button></div>
        </form>
        <div className="mt-4 space-y-2">
          {networks.map(network=><div key={network.id} className="flex items-center justify-between border-t py-2">
            <div><strong className="text-sm">{network.name}</strong>
              <span className="ml-2 text-xs">{network.cidr}</span>
              <StatusBadge tone={statusTone(network.status)}>{network.status}</StatusBadge>
            </div>
            <ConfirmActionButton size="sm" triggerVariant="ghost" disabled={working}
              confirmTitle={"Delete Network "+network.name+"?"}
              confirmDescription="The Network will be deleted after its application attachments and dependent LAN grants are removed."
              confirmLabel="Delete Network" onConfirm={()=>deleteNetwork(network)}>
              Delete
            </ConfirmActionButton>
          </div>)}
        </div>
      </Card>

      <Card className="mt-5 p-5">
        <h2 className="text-base font-semibold">RP Gate devices</h2>
        <p className="mb-3 text-sm text-[#718096]">Remote Gate devices terminate an encrypted L2 tunnel for selected LAN Attachments, not site-wide routes.</p>
        {gates.length===0?<p className="text-sm">No RP Gate enrolled.</p>:null}
        {gates.map(gate=><div key={gate.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-3">
          <div><strong>{gate.name}</strong>
            <StatusBadge tone={statusTone(gate.status)}>{gate.status}</StatusBadge>
            <span className="ml-2 text-xs">{gate.agentVersion??"Not enrolled"}</span>
            <span className="ml-2 text-xs">{formatDate(gate.lastSeenAt)}</span>
            {gate.lastError?<p className="text-sm text-red-700">{gate.lastError}</p>:null}
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={working||Boolean(gate.revokedAt)}
              onClick={()=>void reEnrollGate(gate)}>Re-enroll</Button>
            <ConfirmActionButton size="sm" disabled={working||Boolean(gate.revokedAt)}
              triggerVariant="ghost" confirmTitle={"Delete RP Gate "+gate.name+"?"}
              confirmDescription="The Gate token is invalidated and any LAN Attachment privileges are revoked."
              confirmLabel="Delete RP Gate" onConfirm={()=>revokeGate(gate)}>Delete</ConfirmActionButton>
          </div>
        </div>)}
      </Card>

      <DeviceVpnPanel tenantId={tenantId} networks={networks}/>

      <Dialog open={createNetworkOpen} onClose={()=>{if(!working)setNetworkOpen(false);}}
        title="Create Network" description="A private tenant-scoped application Network."
        actions={<><Button onClick={()=>setNetworkOpen(false)} disabled={working}>Cancel</Button>
          <Button type="submit" form="create-network-form" disabled={working}>Create Network</Button></>}>
        <form id="create-network-form" className="space-y-3" onSubmit={event=>void createNetwork(event)}>
          <Field label="Name" required error={networkErrors.name}>
            <TextInput required placeholder="private-network" value={networkForm.name} onChange={e=>setNetworkForm({...networkForm,name:e.target.value})}/></Field>
          <Field label="CIDR" error={networkErrors.cidr}>
            <TextInput value={networkForm.cidr} placeholder="Automatically allocated" onChange={e=>setNetworkForm({...networkForm,cidr:e.target.value})}/></Field>
          <Field label="Description" error={networkErrors.description}>
            <TextInput value={networkForm.description} onChange={e=>setNetworkForm({...networkForm,description:e.target.value})}/></Field>
        </form>
      </Dialog>
      <Dialog open={createGateOpen} onClose={()=>{if(!working){setGateOpen(false);setEnrollment(undefined);}}}
        title={enrollment?"Install RP Gate":"Add RP Gate"}
        description="The Gate must have a dedicated, unnumbered Ethernet port or isolated VLAN for customer LAN Attachment."
        actions={enrollment?<Button onClick={()=>{setEnrollment(undefined);setGateOpen(false);}}>Done</Button>:
          <><Button onClick={()=>setGateOpen(false)} disabled={working}>Cancel</Button>
          <Button type="submit" form="create-gate-form" disabled={working}>Create RP Gate</Button></>}>
        {enrollment?<div className="space-y-3">
          <Callout tone="warning" title="One-time enrollment token">
            This credential expires {formatDate(enrollment.enrollment.expiresAt)}. Treat the installation command as a secret.
          </Callout>
          <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-white">{installerCommand(enrollment)}</pre>
          <Button onClick={()=>void navigator.clipboard.writeText(installerCommand(enrollment))}>Copy command</Button>
        </div>:<form id="create-gate-form" className="space-y-3" onSubmit={event=>void createGate(event)}>
          <Field label="Name" required error={gateErrors.name}>
            <TextInput required placeholder="remote-gate" value={gateForm.name} onChange={e=>setGateForm({...gateForm,name:e.target.value})}/></Field>
          <Field label="Description" error={gateErrors.description}>
            <TextInput value={gateForm.description} onChange={e=>setGateForm({...gateForm,description:e.target.value})}/></Field>
        </form>}
      </Dialog>
    </main>
  );
}
