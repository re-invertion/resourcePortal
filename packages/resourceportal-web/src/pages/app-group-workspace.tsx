import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest } from "../api/client";
import { CommandBar, type CommandAction } from "../components/command-bar";
import { ResourceIcon } from "../components/icons";
import { SectionNav, StatusBadge } from "../components/ui";
import { tenantHref } from "../router/router";

type AppGroupView = Record<string, unknown>;

type AppGroupWorkspaceProps = {
  tenantId: string;
  appGroupId: string;
  apps: ReactNode;
  config: ReactNode;
  networking: ReactNode;
  deployments: ReactNode;
  activity: ReactNode;
  advanced: ReactNode;
};

function label(value: unknown, fallback = "Unknown") {
  return typeof value === "string" && value ? value : fallback;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function blockerMessage(blockers: string[]) {
  if (blockers.includes("BillingSuspended")) return {
    title: "This App Group cannot start because the tenant balance is empty",
    detail: "Add credits to remove the billing runtime blocker.",
    action: "billing" as const,
  };
  if (blockers.includes("TenantSuspended")) return { title: "This tenant is suspended", detail: "Runtime operations remain unavailable until the tenant is active again." };
  if (blockers.includes("PlatformMaintenance")) return { title: "Platform maintenance is active", detail: "Runtime operations will be available again after maintenance ends." };
  if (blockers.includes("AppGroupError")) return { title: "This App Group is in an error state", detail: "Review deployments and activity before retrying runtime operations." };
  if (blockers.includes("AppGroupNotDeployed")) return { title: "Deploy this App Group before starting it", detail: "Create a deployment from the Deployments section." };
  return blockers.length ? { title: "Runtime is currently blocked", detail: blockers.join(", ") } : undefined;
}

function WorkspaceSection({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return <section className="rp-workspace-section" id={id} aria-labelledby={`${id}-title`}>
    <header><div><p className="rp-eyebrow">{eyebrow}</p><h2 id={`${id}-title`}>{title}</h2></div></header>
    <div className="rp-workspace-section-body">{children}</div>
  </section>;
}

export function AppGroupWorkspace(props: AppGroupWorkspaceProps) {
  const { tenantId, appGroupId, apps, config, networking, deployments, activity } = props;
  const root = `/api/tenants/${encodeURIComponent(tenantId)}/app-groups/${encodeURIComponent(appGroupId)}`;
  const [appGroup, setAppGroup] = useState<AppGroupView>();
  const [loadError, setLoadError] = useState<unknown>();
  const [actionError, setActionError] = useState<unknown>();
  const [working, setWorking] = useState<string>();

  const load = useCallback(async () => {
    try {
      setLoadError(undefined);
      setAppGroup(await apiRequest<AppGroupView>(root));
    } catch (error) {
      setLoadError(error);
    }
  }, [root]);

  useEffect(() => { void load(); }, [load]);

  const blockers = useMemo(() => strings(appGroup?.runtimeBlockers).filter((blocker) => blocker !== "AppGroupStopped"), [appGroup]);
  const blocker = blockerMessage(blockers);
  const externallyBlocked = blockers.some((item) => ["BillingSuspended", "TenantSuspended", "PlatformMaintenance", "AppGroupError", "AppGroupDeleting"].includes(item));
  const runtimeState = label(appGroup?.runtimeState, "Stopped");
  const effectiveState = label(appGroup?.effectiveRuntimeState, runtimeState);
  const health = label(appGroup?.health);
  const drift = label(appGroup?.driftStatus);
  const name = label(appGroup?.name, appGroupId);
  const pending = appGroup?.hasPendingChanges === true;
  const deployment = appGroup?.currentDeploymentVersion == null ? "Not deployed" : `v${String(appGroup.currentDeploymentVersion)}`;
  const lastDeployment = typeof appGroup?.lastDeploymentAt === "string" ? appGroup.lastDeploymentAt : undefined;

  async function runtimeAction(action: "start" | "stop" | "restart") {
    setWorking(action);
    setActionError(undefined);
    try {
      await apiRequest(`${root}/runtime/${action}`, { method: "POST" });
      await load();
    } catch (error) {
      setActionError(error);
    } finally {
      setWorking(undefined);
    }
  }

  const actions: CommandAction[] = [
    ...(pending ? [{ id: "deploy", label: "Deploy changes", href: "#deployments" }] : []),
    ...(runtimeState === "Stopped"
      ? [{ id: "start", label: working === "start" ? "Starting…" : "Start", disabled: !!working || externallyBlocked, onClick: () => void runtimeAction("start") }]
      : [{ id: "restart", label: working === "restart" ? "Restarting…" : "Restart", disabled: !!working || externallyBlocked, onClick: () => void runtimeAction("restart") }]),
    ...(runtimeState === "Stopped" ? [] : [{ id: "stop", label: working === "stop" ? "Stopping…" : "Stop", disabled: !!working, onClick: () => void runtimeAction("stop"), overflow: true }]),
    { id: "refresh", label: "Refresh", onClick: () => void load(), overflow: true },
    { id: "activity", label: "View activity", href: "#activity", overflow: true },
  ];

  return <main className="rp-app-group-workspace">
    <header className="rp-app-group-header rp-resource-header" data-testid="app-group-header">
      <div className="rp-app-group-title">
        <div className="rp-app-group-mark rp-resource-header-icon" aria-hidden="true"><ResourceIcon name="app-group" /></div>
        <div>
          <p className="rp-eyebrow">App Group</p>
          <h1>{appGroup ? name : loadError ? appGroupId : "Loading…"}</h1>
          <div className="rp-app-group-badges">
            {appGroup ? <>
              <StatusBadge>{effectiveState}</StatusBadge>
              <StatusBadge>{health}</StatusBadge>
              <StatusBadge>{drift}</StatusBadge>
              {pending ? <span className="rp-pending-badge">Pending changes</span> : null}
            </> : null}
          </div>
        </div>
      </div>
    </header>

    <CommandBar actions={actions} ariaLabel="App Group actions" />

    {loadError ? <div className="rp-workspace-alert" role="alert"><strong>App Group details are unavailable.</strong><p>Other tenant navigation remains available. Refresh this page to retry.</p></div> : null}
    {actionError ? <div className="rp-workspace-alert" role="alert"><strong>Runtime action failed.</strong><p>{actionError instanceof Error ? actionError.message : "The request could not be completed."}</p></div> : null}
    {blocker ? <div className="rp-workspace-alert" data-tone={blockers.includes("BillingSuspended") ? "negative" : "warning"} role="alert"><div><strong>{blocker.title}</strong><p>{blocker.detail}</p></div>{blocker.action === "billing" ? <a href={tenantHref(tenantId, "billing")}>Add credits</a> : <a href="#deployments">Review deployment</a>}</div> : null}

    <section className="rp-essentials" role="region" aria-label="Essentials">
      <header><h2>Essentials</h2></header>
      <dl className="rp-essentials-grid">
        <div><dt>Desired state</dt><dd>{runtimeState}</dd></div>
        <div><dt>Effective state</dt><dd><StatusBadge>{effectiveState}</StatusBadge></dd></div>
        <div><dt>Health</dt><dd><StatusBadge>{health}</StatusBadge></dd></div>
        <div><dt>Drift</dt><dd><StatusBadge>{drift}</StatusBadge></dd></div>
        <div><dt>Current deployment</dt><dd>{deployment}</dd></div>
        <div><dt>Last deployment</dt><dd>{lastDeployment ? <time dateTime={lastDeployment}>{new Date(lastDeployment).toLocaleString("en-GB")}</time> : "Not available"}</dd></div>
      </dl>
      {pending ? <div className="rp-inline-note"><strong>Changes are waiting to be deployed.</strong><span>Review the deployment section when you are ready to publish them.</span></div> : null}
    </section>

    <SectionNav label="App Group sections" items={[{ label: "Overview", href: "#overview" }, { label: "Apps", href: "#apps" }, { label: "Config", href: "#config" }, { label: "Networking", href: "#networking" }, { label: "Deployments", href: "#deployments" }, { label: "Activity", href: "#activity" }]} />

    <WorkspaceSection id="overview" eyebrow="At a glance" title="Overview">
      <p>Use Essentials for current runtime state. The sections below contain operational configuration and workload management.</p>
    </WorkspaceSection>
    <WorkspaceSection id="apps" eyebrow="Workloads" title="Apps">{apps}</WorkspaceSection>
    <WorkspaceSection id="config" eyebrow="Runtime inputs" title="Config, secrets & variables">{config}</WorkspaceSection>
    <WorkspaceSection id="networking" eyebrow="Traffic" title="Networking">{networking}</WorkspaceSection>
    <WorkspaceSection id="deployments" eyebrow="Delivery" title="Deployments">{deployments}</WorkspaceSection>
    <WorkspaceSection id="activity" eyebrow="Traceability" title="Activity">{activity}</WorkspaceSection>
  </main>;
}
