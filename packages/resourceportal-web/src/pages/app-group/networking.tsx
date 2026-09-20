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
  StatusBadge,
  TextInput,
  TrashIcon,
} from "../../components/design-system";
import { idOf, items, text } from "../../hooks/use-api";

type R = Record<string, unknown>;
type EndpointRow = { app: R; endpoint: R };

export function AppGroupNetworking({
  tenantId,
  appGroupId,
}: {
  tenantId: string;
  appGroupId: string;
}) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}`;
  const [appGroup, setAppGroup] = useState<R>({});
  const [apps, setApps] = useState<R[]>([]);
  const [rows, setRows] = useState<EndpointRow[]>([]);
  const [internalRows, setInternalRows] = useState<R[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointRow>();
  const [appId, setAppId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState(8080);
  const [protocol, setProtocol] = useState("HTTP_REDIRECT_TO_HTTPS");

  const [internalOpen, setInternalOpen] = useState(false);
  const [internalEditing, setInternalEditing] = useState<R>();
  const [internalAppId, setInternalAppId] = useState("");
  const [internalName, setInternalName] = useState("");
  const [internalContainerPort, setInternalContainerPort] = useState(53);
  const [internalPublishedPort, setInternalPublishedPort] = useState(53);
  const [internalProtocol, setInternalProtocol] = useState<"tcp" | "udp">("tcp");

  const networkPrivileged = appGroup.networkPrivileged === true;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [group, appResult, exposureResult] = await Promise.all([
        apiRequest<R>(root),
        apiRequest(`${root}/single-apps`),
        apiRequest(`${root}/internal-port-exposures`),
      ]);
      const appList = items<R>(appResult);
      setAppGroup(group);
      setApps(appList);
      setAppId((current) => current || (appList[0] ? idOf(appList[0]) : ""));
      setInternalAppId((current) =>
        current || (appList[0] ? idOf(appList[0]) : ""),
      );
      setInternalRows(items<R>(exposureResult));
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
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Networking could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [root]);

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
    setError(undefined);
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Endpoint could not be saved.");
    } finally {
      setWorking(false);
    }
  }

  async function remove(row: EndpointRow) {
    try {
      await apiRequest(
        `${root}/single-apps/${encodeURIComponent(idOf(row.app))}/http-endpoints/${encodeURIComponent(idOf(row.endpoint))}`,
        { method: "DELETE" },
      );
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Endpoint could not be deleted.",
      );
    }
  }

  function beginInternal(row?: R) {
    setInternalEditing(row);
    setInternalAppId(
      row ? text(row.singleAppId) : apps[0] ? idOf(apps[0]) : "",
    );
    setInternalName(text(row?.name, ""));
    setInternalContainerPort(Number(row?.containerPort ?? 53));
    setInternalPublishedPort(Number(row?.publishedPort ?? 53));
    setInternalProtocol(text(row?.protocol, "tcp") === "udp" ? "udp" : "tcp");
    setInternalOpen(true);
  }

  async function saveInternal() {
    if (
      !networkPrivileged ||
      !internalAppId ||
      !internalName ||
      !internalContainerPort ||
      !internalPublishedPort
    ) {
      return;
    }
    setWorking(true);
    setError(undefined);
    try {
      const base = `${root}/single-apps/${encodeURIComponent(internalAppId)}/internal-port-exposures`;
      const exposureId = internalEditing ? idOf(internalEditing) : "";
      await apiRequest(
        `${base}${exposureId ? `/${encodeURIComponent(exposureId)}` : ""}`,
        {
          method: exposureId ? "PATCH" : "POST",
          body: {
            name: internalName,
            containerPort: internalContainerPort,
            publishedPort: internalPublishedPort,
            protocol: internalProtocol,
          },
        },
      );
      setInternalOpen(false);
      setInternalEditing(undefined);
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Internal port exposure could not be saved.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function removeInternal(row: R) {
    const singleAppId = text(row.singleAppId);
    try {
      await apiRequest(
        `${root}/single-apps/${encodeURIComponent(singleAppId)}/internal-port-exposures/${encodeURIComponent(idOf(row))}`,
        { method: "DELETE" },
      );
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Internal port exposure could not be deleted.",
      );
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Networking</h2>
          <p className="mt-1 text-sm text-[#5B6678]">
            HTTP routing and controlled internal-network port exposure for applications in this App Group.
          </p>
        </div>
        <Button variant="primary" disabled={!apps.length} onClick={() => begin()}>
          <PlusIcon size={15} /> Add endpoint
        </Button>
      </div>

      {error ? (
        <Callout tone="danger" title="Networking request failed">
          {error}
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
              <option value="HTTP">HTTP</option>
              <option value="HTTPS">HTTPS</option>
              <option value="HTTP_AND_HTTPS">HTTP + HTTPS</option>
              <option value="HTTP_REDIRECT_TO_HTTPS">HTTP redirect to HTTPS</option>
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
                  <strong>{text(row.app.name)}</strong>
                </span>
              ),
              endpoint: text(row.endpoint.name),
              port: text(row.endpoint.containerPort),
              protocol: text(row.endpoint.protocolMode, "HTTP"),
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

      <Card className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <NetworkIcon className="mt-0.5 text-[#1769E0]" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">Internal Port Exposures</h3>
                <StatusBadge tone={networkPrivileged ? "warning" : "neutral"}>
                  {networkPrivileged ? "Privileged networking" : "Platform Admin required"}
                </StatusBadge>
              </div>
              <p className="mt-1 text-sm leading-5 text-[#5B6678]">
                Publish TCP or UDP directly on Swarm nodes for trusted internal-network clients. Internet sources are rejected by the ResourcePortal network guard.
              </p>
            </div>
          </div>
          {networkPrivileged ? (
            <Button
              variant="primary"
              disabled={!apps.length}
              onClick={() => beginInternal()}
            >
              <PlusIcon size={15} /> Add internal port
            </Button>
          ) : null}
        </div>

        {!networkPrivileged ? (
          <div className="mt-4">
            <Callout tone="warning" title="Privileged networking is disabled">
              A Platform Administrator must grant privileged networking to this App Group before private-network egress or internal TCP/UDP publishing can be configured.
            </Callout>
          </div>
        ) : (
          <div className="mt-4">
            <Callout tone="warning" title="Deployment required for port changes">
              Adding, editing or removing an internal port changes the App Group deployment artifact. Deploy the App Group to apply the published-port change.
            </Callout>
          </div>
        )}
      </Card>

      {networkPrivileged && internalOpen ? (
        <Card className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-5">
          <Field label="Application" required>
            <Select
              value={internalAppId}
              onChange={(event) => setInternalAppId(event.target.value)}
              disabled={Boolean(internalEditing)}
            >
              {apps.map((app) => (
                <option key={idOf(app)} value={idOf(app)}>
                  {text(app.name, "Application")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Exposure name" required>
            <TextInput
              value={internalName}
              onChange={(event) => setInternalName(event.target.value)}
              placeholder="dns-udp"
            />
          </Field>
          <Field label="Container port" required>
            <NumberInput
              min={1}
              max={65535}
              value={internalContainerPort}
              onChange={(event) => setInternalContainerPort(Number(event.target.value))}
            />
          </Field>
          <Field label="Published port" required hint="SSH, ResourcePortal, NFS, Swarm and enrollment host ports are reserved">
            <NumberInput
              min={1}
              max={65535}
              value={internalPublishedPort}
              onChange={(event) => setInternalPublishedPort(Number(event.target.value))}
            />
          </Field>
          <Field label="Protocol">
            <Select
              value={internalProtocol}
              onChange={(event) =>
                setInternalProtocol(event.target.value === "udp" ? "udp" : "tcp")
              }
            >
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </Select>
          </Field>
          <div className="flex gap-2 md:col-span-2 xl:col-span-5">
            <Button
              variant="primary"
              disabled={working}
              onClick={() => void saveInternal()}
            >
              {working
                ? "Saving…"
                : internalEditing
                  ? "Save internal port"
                  : "Create internal port"}
            </Button>
            <Button onClick={() => setInternalOpen(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {networkPrivileged ? (
        <Card className="overflow-hidden">
          <DataTable
            embedded
            loading={loading}
            columns={[
              { key: "app", label: "Application" },
              { key: "name", label: "Exposure" },
              { key: "mapping", label: "Port mapping" },
              { key: "protocol", label: "Protocol" },
              { key: "scope", label: "Scope" },
              { key: "actions", label: "" },
            ]}
            rows={internalRows.map((row) => ({
              key: idOf(row),
              cells: {
                app: text(row.singleAppName, text(row.singleAppId)),
                name: text(row.name),
                mapping: `${text(row.publishedPort)} → ${text(row.containerPort)}`,
                protocol: text(row.protocol, "tcp").toUpperCase(),
                scope: "Internal network only",
                actions: (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => beginInternal(row)}>
                      Edit
                    </Button>
                    <ConfirmActionButton
                      size="sm"
                      triggerVariant="ghost"
                      ariaLabel={`Delete internal port ${text(row.name)}`}
                      confirmTitle={`Delete internal port ${text(row.name)}?`}
                      confirmDescription="The currently deployed port remains active and firewall-protected until you deploy the App Group changes."
                      confirmLabel="Delete internal port"
                      onConfirm={() => removeInternal(row)}
                    >
                      <TrashIcon size={15} />
                    </ConfirmActionButton>
                  </div>
                ),
              },
            }))}
            empty={
              <EmptyState
                icon={<NetworkIcon />}
                title="No internal ports"
                description="Publish TCP or UDP only when this trusted App Group needs to serve clients on the internal network."
              />
            }
          />
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <GlobeIcon className="mt-0.5 text-[#1769E0]" />
          <div>
            <h3 className="font-semibold">Domains & routing</h3>
            <p className="mt-1 text-sm text-[#5B6678]">
              Tenant domains are managed centrally and can be used by routing policies supported by the platform.
            </p>
            <a
              className="mt-2 inline-block text-sm font-semibold text-[#0F56A7] hover:underline"
              href={`/tenants/${encodeURIComponent(tenantId)}/domains`}
            >
              Manage tenant domains
            </a>
          </div>
        </div>
      </Card>
    </section>
  );
}
