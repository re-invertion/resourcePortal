import { useMemo, useState } from "react";
import { apiRequest } from "../../api/client";
import { applicationHref, appGroupHref } from "../../router/router";
import { ActivityIcon, Button, Card, Callout, DetailList, EditIcon, ExternalIcon, GridIcon, KeyIcon, LinkButton, NetworkIcon, PlayIcon, RestartIcon, ServerIcon, StatusBadge, StatusText, StopIcon, VolumeIcon, statusTone } from "../../components/design-system";
import { formatBytes, items, text, useApi } from "../../hooks/use-api";
import { ApplicationNavigation, type ApplicationSection } from "./application-navigation";
import { toast } from "../../components/toast";

type R = Record<string, unknown>;
export function ApplicationDetail({ tenantId, appGroupId, appId, section = "overview" }: { tenantId: string; appGroupId: string; appId: string; section?: ApplicationSection }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}`;
  const appRoot = `${root}/single-apps/${encodeURIComponent(appId)}`;
  const appsQuery = useApi<unknown>(`${root}/single-apps`);
  const runtime = useApi<R>(`${appRoot}/runtime-config`);
  const endpoints = useApi<unknown>(`${appRoot}/http-endpoints`);
  const [working, setWorking] = useState<string>();
  const app = useMemo(() => items<R>(appsQuery.data).find(item => text(item.id, "") === appId), [appsQuery.data, appId]);

  async function runtimeAction(action: "start" | "stop" | "restart") {
    setWorking(action);
    try {
      await apiRequest(`${appRoot}/runtime/${action}`, { method: "POST" });
      await appsQuery.reload();
      toast.success(`Application ${action === "start" ? "started" : action === "stop" ? "stopped" : "restarted"}.`);
    } catch (cause) {
      toast.errorFrom(cause, `Application ${action} failed.`);
    } finally {
      setWorking(undefined);
    }
  }

  if (appsQuery.loading) return <Card className="p-6"><p className="text-sm text-[#5B6678]">Loading application…</p></Card>;
  if (appsQuery.error || !app) return <Callout tone="danger" title="Application could not be loaded">The application may have been removed or you may not have permission to view it.</Callout>;
  const effective = text(app.effectiveRuntimeState, app.runtimeState as string);
  const health = text(app.health, "Unknown");
  const endpointRows = items<R>(endpoints.data);
  const env = runtime.data?.environment && typeof runtime.data.environment === "object" ? Object.entries(runtime.data.environment as Record<string, unknown>) : [];
  const secretRows = Array.isArray(runtime.data?.secrets) ? runtime.data.secrets as R[] : [];
  const running = effective.toLowerCase() === "running";

  return <section className="space-y-5">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
      <div className="flex min-w-0 gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#E7F1FF] text-[#1769E0]"><GridIcon size={20}/></span><div className="min-w-0"><p className="text-[12px] font-semibold uppercase tracking-[.03em] text-[#1769E0]">Application</p><h2 className="truncate text-2xl font-semibold">{text(app.name,"Application")}</h2><p className="mt-1 max-w-2xl text-sm text-[#5B6678]">{text(app.description,text(app.image,"Container workload"))}</p><div className="mt-3 flex flex-wrap gap-2"><StatusBadge tone={statusTone(effective)}>{effective}</StatusBadge><StatusBadge tone={statusTone(health)}>{health}</StatusBadge>{app.pendingDeletion===true?<StatusBadge tone="danger">Pending deletion</StatusBadge>:null}</div></div></div>
      <div className="flex flex-wrap gap-2">{running?<Button aria-label="Stop application" disabled={Boolean(working)} onClick={()=>void runtimeAction("stop")}><StopIcon size={16}/>{working==="stop"?"Stopping…":"Stop"}</Button>:<Button aria-label="Start application" disabled={Boolean(working)} onClick={()=>void runtimeAction("start")}><PlayIcon size={16}/>{working==="start"?"Starting…":"Start"}</Button>}<Button aria-label="Restart application" disabled={Boolean(working)} onClick={()=>void runtimeAction("restart")}><RestartIcon size={16}/>{working==="restart"?"Restarting…":"Restart"}</Button><LinkButton href={applicationHref(tenantId,appGroupId,appId,"edit")}><EditIcon size={16}/>Edit application</LinkButton></div>
    </div>
    <ApplicationNavigation tenantId={tenantId} appGroupId={appGroupId} appId={appId} active={section} />
    <div className="grid gap-4 xl:grid-cols-[1.35fr_.9fr]"><div className="space-y-4"><Card className="p-5"><div className="mb-4 flex items-center gap-2"><ServerIcon size={18} className="text-[#1769E0]"/><h3 className="text-base font-semibold">Runtime configuration</h3></div><DetailList items={[{label:"Container image",value:<code className="break-all text-[13px]">{text(app.image)}</code>},{label:"Desired replicas",value:text(app.desiredReplicas,"0")},{label:"Effective replicas",value:text(app.effectiveReplicas,app.desiredReplicas as string)},{label:"CPU",value:`${text(app.cpu,"0")} cores`},{label:"Memory",value:formatBytes(app.memoryBytes)},{label:"Desired runtime",value:text(app.runtimeState,"Unknown")},{label:"Working directory",value:text(app.workingDir)},{label:"Container user",value:text(app.user)}]}/></Card><Card className="overflow-hidden"><div className="flex items-center justify-between border-b border-[#E1E7F0] px-5 py-4"><div className="flex items-center gap-2"><NetworkIcon size={18} className="text-[#1769E0]"/><div><h3 className="text-base font-semibold">HTTP endpoints</h3><p className="text-xs text-[#718096]">Public and private routes exposed by this application.</p></div></div><LinkButton variant="ghost" className="h-8" href={applicationHref(tenantId,appGroupId,appId,"edit/networking")}>Manage</LinkButton></div>{endpoints.loading?<p className="p-5 text-sm text-[#5B6678]">Loading endpoints…</p>:endpointRows.length?<div className="divide-y divide-[#E1E7F0]">{endpointRows.map(ep=><div key={text(ep.id)} className="flex items-center gap-3 px-5 py-3"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#F0F5FC] text-[#1769E0]"><ExternalIcon size={15}/></span><div className="min-w-0 flex-1"><strong className="block truncate text-[13px]">{text(ep.name,"Endpoint")}</strong><span className="text-xs text-[#718096]">Port {text(ep.containerPort)} · {text(ep.protocolMode,"HTTP")}</span></div><StatusText tone={statusTone(ep.status)}>{text(ep.status,"Configured")}</StatusText></div>)}</div>:<p className="p-5 text-sm text-[#5B6678]">No HTTP endpoints configured.</p>}</Card></div><div className="space-y-4"><Card className="p-5"><div className="mb-3 flex items-center gap-2"><KeyIcon size={17} className="text-[#1769E0]"/><h3 className="text-base font-semibold">Configuration</h3></div><div className="space-y-3 text-[13px]"><div className="flex justify-between"><span className="text-[#718096]">Environment variables</span><strong>{env.length}</strong></div><div className="flex justify-between"><span className="text-[#718096]">Runtime secrets</span><strong>{secretRows.length}</strong></div><div className="flex justify-between"><span className="text-[#718096]">App Group attachments</span><a href={applicationHref(tenantId,appGroupId,appId,"edit/configuration")} className="font-semibold text-[#0F56A7]">Manage</a></div></div></Card><Card className="p-5"><div className="mb-3 flex items-center gap-2"><VolumeIcon size={17} className="text-[#1769E0]"/><h3 className="text-base font-semibold">Storage</h3></div><p className="text-[13px] leading-5 text-[#5B6678]">Volumes and reusable App Group resources can be attached from the editor. Secret values are never returned by the API.</p><a href={applicationHref(tenantId,appGroupId,appId,"edit/storage")} className="mt-3 inline-block text-[13px] font-semibold text-[#0F56A7] hover:underline">Manage storage</a></Card><Card className="p-5"><div className="mb-3 flex items-center gap-2"><ActivityIcon size={17} className="text-[#1769E0]"/><h3 className="text-base font-semibold">Advanced runtime options</h3></div><DetailList columns={1} items={[{label:"Entrypoint",value:text(app.entrypoint)},{label:"Command",value:Array.isArray(app.command)&&app.command.length?(app.command as unknown[]).map(String).join(" "):"Default image command"},{label:"Read-only root filesystem",value:app.readOnlyRootFilesystem===true?"Enabled":"Disabled"},{label:"Stop grace period",value:app.stopGracePeriodSeconds==null?"Default":`${text(app.stopGracePeriodSeconds)} seconds`} ]}/><a href={applicationHref(tenantId,appGroupId,appId,"edit/advanced")} className="mt-4 inline-block text-[13px] font-semibold text-[#0F56A7] hover:underline">Open advanced settings</a></Card></div></div>
    <a href={appGroupHref(tenantId,appGroupId,"apps")} className="text-[13px] font-medium text-[#526070] hover:underline">Back to apps</a>
  </section>;
}
