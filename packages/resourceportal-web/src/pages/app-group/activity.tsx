import { Card, DataTable, EmptyState, ActivityIcon, ErrorState, StatusText, statusTone } from "../../components/design-system";
import { formatDate, idOf, items, text, useApi } from "../../hooks/use-api";
import { tenantHref } from "../../router/router";
import { belongsToAppGroup } from "./activity-scope";

type R = Record<string, unknown>;

export function AppGroupActivity({ tenantId, appGroupId }: { tenantId: string; appGroupId: string }) {
  const tenantRoot = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const root = `${tenantRoot}/app-groups/${encodeURIComponent(appGroupId)}`;
  const operations = useApi<unknown>(`${tenantRoot}/operations`);
  const apps = useApi<unknown>(`${root}/single-apps`);
  const deployments = useApi<unknown>(`${root}/deployments`);
  const appIds = new Set(items<R>(apps.data).map(idOf));
  const deploymentIds = new Set(items<R>(deployments.data).map(idOf));
  const loading = operations.loading || apps.loading || deployments.loading;
  const rows = !loading && !operations.error && !apps.error && !deployments.error
    ? items<R>(operations.data).filter(op => belongsToAppGroup(op, appGroupId, appIds, deploymentIds))
    : [];
  return <section className="space-y-4">
    <div><h2 className="text-xl font-semibold">Activity</h2><p className="mt-1 text-sm text-[#5B6678]">Operations explicitly linked to this App Group, its apps or deployments. Unrelated tenant operations are excluded.</p></div>
    {operations.error || apps.error || deployments.error
      ? <ErrorState title="Activity relationships could not be verified" error={operations.error || apps.error || deployments.error} retry={() => void Promise.all([operations.reload(), apps.reload(), deployments.reload()])} />
      : <Card className="overflow-hidden"><DataTable embedded loading={loading}
        columns={[{ key: "type", label: "Operation" }, { key: "resource", label: "Resource" }, { key: "status", label: "Status" }, { key: "actor", label: "Actor" }, { key: "time", label: "Timestamp" }]}
        rows={rows.map(op => ({
          key: idOf(op),
          href: tenantHref(tenantId, "operations", idOf(op)),
          cells: {
            type: <strong>{text(op.type, "Operation").replaceAll("_", " ")}</strong>,
            resource: text(op.resourceName, text(op.resourceType, "App Group")),
            status: <StatusText tone={statusTone(op.status)}>{text(op.status, "Unknown")}</StatusText>,
            actor: text(op.createdByDisplayName, text(op.createdByEmail, text(op.createdBy, "System"))),
            time: formatDate(op.createdAt ?? op.updatedAt),
          },
        }))}
        empty={<EmptyState icon={<ActivityIcon />} title="No related activity" description="Only operations linked to this App Group and its workloads appear here." />}
      /></Card>}
  </section>;
}
