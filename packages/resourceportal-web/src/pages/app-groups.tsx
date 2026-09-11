import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api/client";
import { CommandBar } from "../components/command-bar";
import { ErrorState } from "../components/resource";
import { PageHeader, StatusBadge } from "../components/ui";
import { AppGroupCreateWizard } from "./app-group-create";

export type AppGroupListItem = {
  id: string;
  name: string;
  runtimeState: string;
  effectiveRuntimeState: string;
  health: string;
  driftStatus: string;
  hasPendingChanges: boolean;
  currentDeploymentVersion?: number;
  updatedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

export function toAppGroupListItem(value: unknown): AppGroupListItem | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return undefined;
  const runtimeState = stringValue(value.runtimeState, "Stopped");
  return {
    id: value.id,
    name: stringValue(value.name, value.id),
    runtimeState,
    effectiveRuntimeState: stringValue(value.effectiveRuntimeState, runtimeState),
    health: stringValue(value.health, "Unknown"),
    driftStatus: stringValue(value.driftStatus, "Unknown"),
    hasPendingChanges: value.hasPendingChanges === true,
    currentDeploymentVersion: typeof value.currentDeploymentVersion === "number" ? value.currentDeploymentVersion : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

function listItems(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : [];
  return raw.map(toAppGroupListItem).filter((item): item is AppGroupListItem => !!item);
}

function allowed(permissions: string[] | undefined, permission: string) {
  if (!permissions) return true;
  return permissions.includes("*") || permissions.includes(permission);
}

export function AppGroupsPage({ tenantId, permissions }: { tenantId: string; permissions?: string[] }) {
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups`;
  const [items, setItems] = useState<AppGroupListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setItems(listItems(await apiRequest(root)));
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => { void reload(); }, [reload]);

  const canCreate = allowed(permissions, "appgroup.create");
  const actions = [
    ...(canCreate ? [{ id: "create", label: "Create AppGroup", onClick: () => setCreateOpen(true) }] : []),
    { id: "refresh", label: "Refresh", onClick: () => void reload() },
  ];

  return <main className="rp-app-groups-page">
    <PageHeader
      eyebrow="Applications"
      title="App Groups"
      description="Manage application groups, runtime state, deployments and pending configuration changes."
    />
    <CommandBar actions={actions} ariaLabel="App Group actions" />

    {error ? <ErrorState error={error} /> : null}
    {canCreate && createOpen ? <AppGroupCreateWizard
      tenantId={tenantId}
      onCancel={() => setCreateOpen(false)}
      onCreated={async (id) => {
        setCreateOpen(false);
        await reload();
        if (id && typeof window !== "undefined") {
          window.location.assign(`/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(id)}`);
        }
      }}
    /> : null}

    {loading ? <p className="rp-resource-loading">Loading App Groups…</p> : items.length === 0 ? <section className="rp-empty-state">
      <h2>No App Groups yet</h2>
      <p>Create an App Group to establish a deployable workload boundary for this tenant.</p>
      {canCreate && !createOpen ? <button type="button" onClick={() => setCreateOpen(true)}>Create AppGroup</button> : null}
    </section> : <div className="rp-resource-table-wrap">
      <table className="rp-resource-table">
        <thead><tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Health</th>
          <th scope="col">Drift</th>
          <th scope="col">Deployment</th>
          <th scope="col">Changes</th>
        </tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td><a href={`/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(item.id)}`}>{item.name}</a></td>
          <td><StatusBadge>{item.effectiveRuntimeState}</StatusBadge></td>
          <td><StatusBadge>{item.health}</StatusBadge></td>
          <td><StatusBadge>{item.driftStatus}</StatusBadge></td>
          <td>{item.currentDeploymentVersion == null ? "Not deployed" : `v${item.currentDeploymentVersion}`}</td>
          <td>{item.hasPendingChanges ? "Pending changes" : "Up to date"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </main>;
}
