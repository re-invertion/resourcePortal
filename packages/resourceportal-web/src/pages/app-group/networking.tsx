import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../api/client";
import {
  Button,
  Callout,
  Card,
  ConfirmActionButton,
  DataTable,
  EmptyState,
  Field,
  GlobeIcon,
  NetworkIcon,
  NumberInput,
  PlusIcon,
  Select,
  TextInput,
  TrashIcon,
} from "../../components/design-system";
import { idOf, items, text, useApi } from "../../hooks/use-api";
import { toast } from "../../components/toast";
import { applicationHref, tenantHref } from "../../router/router";
import type { Topology } from "../tenant-networking-graph";

type R = Record<string, unknown>;
type EndpointRow = { app: R; endpoint: R };
type Membership = { appId: string; appName: string; networkId: string; networkName: string; address: string; gateName?: string; grantStatus?: string };

/** Human-readable labels, while the API retains its stable protocol mode values. */
export function protocolModeLabel(value: unknown): string {
  switch (value) {
    case "HTTP": return "HTTP only";
    case "HTTPS": return "HTTPS only";
    case "HTTP_AND_HTTPS": return "HTTP + HTTPS";
    case "HTTP_REDIRECT_TO_HTTPS": return "HTTP → HTTPS redirect";
    default: return "Unknown protocol mode";
  }
}

export function AppGroupNetworking({
  tenantId,
  appGroupId,
}: {
  tenantId: string;
  appGroupId: string;
}) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}`;
  const [apps, setApps] = useState<R[]>([]);
  const [rows, setRows] = useState<EndpointRow[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [membershipError, setMembershipError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [working, setWorking] = useState(false);
  const tenantDomainsRoot = `/api/tenants/${encodeURIComponent(tenantId)}/domains`;
  const domains = useApi<unknown>(tenantDomainsRoot);
  const tenantDomainRows = items<R>(domains.data).filter(domain => !domain.tenantId || domain.tenantId === tenantId);
  const [domainId, setDomainId] = useState("");
  const [targetEndpointId, setTargetEndpointId] = useState("");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointRow>();
  const [appId, setAppId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState(8080);
  const [protocol, setProtocol] = useState("HTTP_REDIRECT_TO_HTTPS");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const appResult = await apiRequest(`${root}/single-apps`);
      const appList = items<R>(appResult);
      setApps(appList);
      setAppId((current) => current || (appList[0] ? idOf(appList[0]) : ""));
      const all = await Promise.all(
        appList.map(async (app) =>
          items<R>(
            await apiRequest(
              `${root}/single-apps/${encodeURIComponent(idOf(app))}/http-endpoints`,
            ),
          ).map((endpoint) => ({ app, endpoint })),
        ),
      );
      setRows(all.flat());
      // Both APIs are tenant-scoped. A failed read must not be rendered as an
      // empty membership set or prevent HTTP endpoint editing.
      try {
        const topology = await apiRequest<Topology>(
          `/api/tenants/${encodeURIComponent(tenantId)}/networking/topology`,
        );
        const group = topology.appGroups?.find(item => item.id === appGroupId);
        const lanResult = await apiRequest<unknown>(
          `/api/tenants/${encodeURIComponent(tenantId)}/networking/lan-attachments`,
        );
        const lan = items<R>(lanResult);
        const byNetwork = new Map((topology.networks ?? []).map(item => [item.id, item.name]));
        const byGate = new Map((topology.gates ?? []).map(item => [item.id, item.name]));
        setMemberships((group?.singleApps ?? []).flatMap(app =>
          (app.networkAttachments ?? []).map(link => {
            const grant = lan.find(row => row.singleAppId === app.id && row.networkId === link.networkId);
            return {
              appId: app.id, appName: app.name, networkId: link.networkId,
              networkName: byNetwork.get(link.networkId) ?? "Unnamed Network",
              address: link.address,
              gateName: grant ? byGate.get(text(grant.gateId)) ?? "Unknown Gate" : undefined,
              grantStatus: grant ? text(grant.status, "Unknown") : undefined,
            };
          }),
        ));
        setMembershipError(undefined);
      } catch (error) {
        setMemberships([]);
        setMembershipError(error instanceof Error ? error.message : "Membership data unavailable");
      }
    } catch (caught) {
      setLoadError(
        caught instanceof Error ? caught.message : "Networking could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [root, tenantId, appGroupId]);

  useEffect(() => {
    void load();
  }, [load]);

  function begin(row?: EndpointRow) {
    setEditing(row);
    setAppId(row ? idOf(row.app) : apps[0] ? idOf(apps[0]) : "");
    setName(text(row?.endpoint.name, ""));
    setPort(Number(row?.endpoint.containerPort ?? 8080));
    setProtocol(text(row?.endpoint.protocolMode, "HTTP_REDIRECT_TO_HTTPS"));
    setOpen(true);
  }

  async function save() {
    if (!appId || !name || !port) return;
    setWorking(true);
    try {
      const base = `${root}/single-apps/${encodeURIComponent(appId)}/http-endpoints`;
      const endpointId = editing ? idOf(editing.endpoint) : "";
      await apiRequest(`${base}${endpointId ? `/${encodeURIComponent(endpointId)}` : ""}`, {
        method: endpointId ? "PATCH" : "POST",
        body: { name, containerPort: port, protocolMode: protocol },
      });
      setOpen(false);
      setEditing(undefined);
      await load();
      toast.success(endpointId ? "Endpoint updated." : "Endpoint created.");
    } catch (caught) {
      toast.errorFrom(caught, "Endpoint could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function assignDomain() {
    const domain = tenantDomainRows.find(item => idOf(item) === domainId);
    const target = rows.find(item => idOf(item.endpoint) === targetEndpointId);
    if (!domain || !target || domains.loading || domains.error || loadError) return;
    setWorking(true);
    try {
      await apiRequest(`${tenantDomainsRoot}/${encodeURIComponent(domainId)}`, { method: "PATCH", body: { httpEndpointId: targetEndpointId } });
      await domains.reload();
      toast.success("Domain assignment saved. Deploy the App Group to apply the route.");
    } catch (caught) {
      toast.errorFrom(caught, "Domain assignment failed.");
    } finally { setWorking(false); }
  }

  async function remove(row: EndpointRow) {
    try {
      await apiRequest(
        `${root}/single-apps/${encodeURIComponent(idOf(row.app))}/http-endpoints/${encodeURIComponent(idOf(row.endpoint))}`,
        { method: "DELETE" },
      );
      await load();
      toast.success("Endpoint deleted.");
    } catch (caught) {
      toast.errorFrom(caught, "Endpoint could not be deleted.");
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Networking</h2>
          <p className="mt-1 text-sm text-[#5B6678]">
            HTTP routing for applications in this App Group. Private network membership is managed from tenant Networking.
          </p>
          <a
            className="mt-2 inline-block text-sm font-semibold text-[#0F56A7] hover:underline"
            href={`/tenants/${encodeURIComponent(tenantId)}/networking`}
          >
            Open tenant Networking
          </a>
          <a className="ml-4 inline-block text-sm font-semibold text-[#0F56A7] hover:underline" href={`/tenants/${encodeURIComponent(tenantId)}/domains`}>Add or assign domain</a>
        </div>
        <Button variant="primary" disabled={!apps.length} onClick={() => begin()}>
          <PlusIcon size={15} /> Add endpoint
        </Button>
      </div>

      <Card className="p-5" aria-label="Domain and endpoint assignments">
        <h3 className="font-semibold">Domain and endpoint assignments</h3>
        <p className="mt-1 text-sm text-[#526070]">Assign a domain owned by this tenant directly to an endpoint in this App Group. Reassigning a published hostname changes its routing target after deployment.</p>
        {domains.error ? <Callout tone="danger" title="Domains unavailable">Assignment is disabled until the tenant domain inventory can be verified.</Callout> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label="Tenant domain"><Select aria-label="Tenant domain to assign" value={domainId} disabled={domains.loading || Boolean(domains.error) || working} onChange={event => setDomainId(event.target.value)}><option value="">Select tenant domain</option>{tenantDomainRows.map(domain => <option key={idOf(domain)} value={idOf(domain)}>{text(domain.hostname, "Domain")}</option>)}</Select></Field>
          <Field label="Application endpoint"><Select aria-label="Target HTTP endpoint" value={targetEndpointId} disabled={loading || Boolean(loadError) || working} onChange={event => setTargetEndpointId(event.target.value)}><option value="">Select endpoint</option>{rows.map(row => <option key={idOf(row.endpoint)} value={idOf(row.endpoint)}>{text(row.app.name, "Application")} / {text(row.endpoint.name, "Endpoint")} · {protocolModeLabel(row.endpoint.protocolMode)}</option>)}</Select></Field>
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <ConfirmActionButton triggerVariant="primary" confirmVariant="primary" disabled={!domainId || !targetEndpointId || domains.loading || Boolean(domains.error) || loading || Boolean(loadError) || working || !tenantDomainRows.some(d => idOf(d) === domainId) || !rows.some(r => idOf(r.endpoint) === targetEndpointId)} confirmTitle="Confirm endpoint domain assignment" confirmDescription="Reassign the chosen tenant-owned hostname to this App Group endpoint? The saved routing draft requires deployment; existing published routes may be affected." confirmLabel="Assign domain to endpoint" onConfirm={assignDomain}>Assign domain</ConfirmActionButton>
            <a className="text-sm font-semibold text-[#0F56A7] underline" href={tenantHref(tenantId, "domains")}>Manage domains and DNS</a>
          </div>
        </div>
        {tenantDomainRows.filter(d => { const ep = d.httpEndpoint as R | undefined; return rows.some(row => idOf(row.endpoint) === text(ep?.id, "") && text(ep?.appGroupId, appGroupId) === appGroupId); }).map(d => <p className="mt-2 text-sm" key={idOf(d)}><a className="font-semibold text-[#0F56A7] underline" href={tenantHref(tenantId, "domains", idOf(d))}>{text(d.hostname, "Domain")}</a> → {text((d.httpEndpoint as R | undefined)?.name, "Endpoint")} ({text(d.dnsStatus, "DNS unknown")})</p>)}
      </Card>

      <Card className="p-5" aria-label="Private Network and LAN relationships">
        <h3 className="text-base font-semibold">Private Network and LAN relationships</h3>
        <p className="mt-1 text-sm text-[#526070]">Only verified membership in this App Group is listed. A LAN grant is separate from private Network attachment. Device VPN provides user-device access to tenant Networks, not a direct VPN inside a SingleApp.</p>
        {membershipError ? <Callout tone="warning" title="Network relationships unavailable">{membershipError}</Callout> :
          memberships.length ? <ul className="mt-3 space-y-2">{memberships.map(member =>
            <li key={member.appId + ":" + member.networkId} className="rounded-md border border-[#D7E0EC] p-3 text-sm">
              <a className="font-semibold text-[#0F56A7] underline" href={applicationHref(tenantId,appGroupId,member.appId)}>{member.appName}</a>
              {" → "}<strong>{member.networkName}</strong>
              {" · "}<span className="font-mono">{member.address}</span>
              {" · "}{member.gateName ? `LAN grant via ${member.gateName}: ${member.grantStatus}` : "No LAN L2 grant"}
            </li>)}</ul> :
          <p className="mt-2 text-sm text-[#526070]">No private Network attachments for applications in this App Group.</p>}
        <div className="mt-3 flex flex-wrap gap-4 text-sm">
          <a className="font-semibold text-[#0F56A7] underline" href={tenantHref(tenantId,"networking","networks")}>Manage private Networks</a>
          <a className="font-semibold text-[#0F56A7] underline" href={tenantHref(tenantId,"networking","lan")}>Manage LAN grants and Gates</a>
          <a className="font-semibold text-[#0F56A7] underline" href={tenantHref(tenantId,"networking","vpn")}>Device VPN access</a>
        </div>
      </Card>

      {loadError ? (
        <Callout tone="danger" title="Networking could not be loaded">
          {loadError}
        </Callout>
      ) : null}

      {open ? (
        <Card className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Application" required>
            <Select
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
              disabled={Boolean(editing)}
            >
              {apps.map((app) => (
                <option key={idOf(app)} value={idOf(app)}>
                  {text(app.name, "Application")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Endpoint name" required>
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="web"
            />
          </Field>
          <Field label="Container port" required>
            <NumberInput
              min={1}
              max={65535}
              value={port}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </Field>
          <Field label="Protocol mode">
            <Select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
              <option value="HTTP">{protocolModeLabel("HTTP")}</option>
              <option value="HTTPS">{protocolModeLabel("HTTPS")}</option>
              <option value="HTTP_AND_HTTPS">{protocolModeLabel("HTTP_AND_HTTPS")}</option>
              <option value="HTTP_REDIRECT_TO_HTTPS">{protocolModeLabel("HTTP_REDIRECT_TO_HTTPS")}</option>
            </Select>
          </Field>
          <div className="flex gap-2 md:col-span-2">
            <Button variant="primary" disabled={working} onClick={() => void save()}>
              {working ? "Saving…" : editing ? "Save changes" : "Create endpoint"}
            </Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <DataTable
          embedded
          loading={loading}
          columns={[
            { key: "app", label: "Application" },
            { key: "endpoint", label: "Endpoint" },
            { key: "port", label: "Port" },
            { key: "protocol", label: "Protocol" },
            { key: "actions", label: "" },
          ]}
          rows={rows.map((row) => ({
            key: `${idOf(row.app)}-${idOf(row.endpoint)}`,
            cells: {
              app: (
                <span className="flex items-center gap-2">
                  <NetworkIcon size={15} />
                  <a className="font-semibold text-[#0F56A7] underline" href={applicationHref(tenantId, appGroupId, idOf(row.app))}>{text(row.app.name, "Application")}</a>
                </span>
              ),
              endpoint: text(row.endpoint.name),
              port: text(row.endpoint.containerPort),
              protocol: protocolModeLabel(row.endpoint.protocolMode),
              actions: (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" onClick={() => begin(row)}>
                    Edit
                  </Button>
                  <ConfirmActionButton
                    size="sm"
                    triggerVariant="ghost"
                    ariaLabel={`Delete ${text(row.endpoint.name)}`}
                    confirmTitle={`Delete endpoint ${text(row.endpoint.name)}?`}
                    confirmDescription="This removes the HTTP endpoint and its routing entry from this application."
                    confirmLabel="Delete endpoint"
                    onConfirm={() => remove(row)}
                  >
                    <TrashIcon size={15} />
                  </ConfirmActionButton>
                </div>
              ),
            },
          }))}
          empty={
            <EmptyState
              icon={<GlobeIcon />}
              title="No HTTP endpoints"
              description="Expose an application port when this workload needs HTTP routing."
            />
          }
        />
      </Card>
    </section>
  );
}
