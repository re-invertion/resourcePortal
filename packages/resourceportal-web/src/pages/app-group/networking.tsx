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
  const [apps, setApps] = useState<R[]>([]);
  const [rows, setRows] = useState<EndpointRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointRow>();
  const [appId, setAppId] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState(8080);
  const [protocol, setProtocol] = useState("HTTP_REDIRECT_TO_HTTPS");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
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
    </section>
  );
}
