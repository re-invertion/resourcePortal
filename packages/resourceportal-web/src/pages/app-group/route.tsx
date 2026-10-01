import { Card, ErrorState, LoadingState } from "../../components/design-system";
import { useApi } from "../../hooks/use-api";
import { ApplicationDetail } from "./app-detail";
import { ApplicationEdit } from "./app-edit";
import { AppGroupActivity } from "./activity";
import { AppGroupApps } from "./apps";
import { AppGroupConfig } from "./config";
import { CreateApplicationWizard } from "./create-app-wizard";
import { AppGroupDeployments } from "./deployments";
import { AppGroupLayout } from "./layout";
import { AppGroupOverview } from "./overview";
import { AppGroupSettings } from "./settings";

export function AppGroupRoute({ tenantId, segments }: { tenantId: string; segments: string[] }) {
  const appGroupId = segments[0] ?? "";
  const root = appGroupId ? `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}` : undefined;
  const group = useApi<Record<string, unknown>>(root);

  if (!appGroupId) {
    return <ErrorState title="App Group route is incomplete" error={new Error("The App Group identifier is missing from the route.")} />;
  }
  if (group.loading || (!group.data && !group.error)) return <Card><LoadingState rows={5} /></Card>;
  if (group.error || !group.data) return <ErrorState title="App Group could not be loaded" error={group.error} retry={() => void group.reload()} />;

  const sub = segments.slice(1);
  const section = sub[0] || "overview";
  const appGroupName = typeof group.data.name === "string" && group.data.name ? group.data.name : "App Group";

  // A Single App is a first-class page. Do not render it underneath the App Group
  // header/navigation; the shell owns the single canonical breadcrumb trail.
  if (section === "apps" && sub[1] && sub[1] !== "new") {
    const appId = sub[1];
    if (sub[2] === "edit") {
      return <ApplicationEdit tenantId={tenantId} appGroupId={appGroupId} appGroupName={appGroupName} appId={appId} subsection={sub[3]} />;
    }
    if (sub[2] === "health") {
      return <ApplicationDetail tenantId={tenantId} appGroupId={appGroupId} appGroupName={appGroupName} appId={appId} section="health" />;
    }
    return <ApplicationDetail tenantId={tenantId} appGroupId={appGroupId} appGroupName={appGroupName} appId={appId} />;
  }

  let activeSection = section;
  let content;
  if (section === "overview") content = <AppGroupOverview tenantId={tenantId} group={group.data} />;
  else if (section === "apps" && sub[1] === "new") content = <CreateApplicationWizard tenantId={tenantId} appGroupId={appGroupId} appGroupName={appGroupName} />;
  else if (section === "apps") content = <AppGroupApps tenantId={tenantId} appGroupId={appGroupId} />;
  else if (section === "config") content = <AppGroupConfig tenantId={tenantId} appGroupId={appGroupId} />;
  else if (section === "networking") { activeSection = "apps"; content = <AppGroupApps tenantId={tenantId} appGroupId={appGroupId} />; }
  else if (section === "deployments") content = <AppGroupDeployments tenantId={tenantId} appGroupId={appGroupId} onReload={group.reload} />;
  else if (section === "activity") content = <AppGroupActivity tenantId={tenantId} appGroupId={appGroupId} />;
  else if (section === "settings" || section === "advanced") {
    activeSection = "settings";
    content = <AppGroupSettings tenantId={tenantId} appGroupId={appGroupId} group={group.data} onReload={group.reload} />;
  } else {
    activeSection = "overview";
    content = <AppGroupOverview tenantId={tenantId} group={group.data} />;
  }

  return <AppGroupLayout tenantId={tenantId} group={group.data} section={activeSection} onReload={group.reload}>{content}</AppGroupLayout>;
}