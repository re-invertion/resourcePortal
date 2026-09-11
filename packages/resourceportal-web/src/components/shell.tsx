import type { ReactNode } from "react";
import type { AppRoute } from "../router/router";
import { tenantHref } from "../router/router";
import { ResourceIcon, type ResourceIconName } from "./icons";

type ShellUser = { id: string; email?: string; displayName?: string };
type NavItem = { label: string; href: string; section: string; icon: ResourceIconName };
type NavGroup = { label: string; items: NavItem[] };

function initials(user: ShellUser) {
  const source = user.displayName ?? user.email ?? user.id;
  return source.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "RP";
}

function activeSection(route: AppRoute) {
  return route.kind === "tenant" || route.kind === "platform" ? route.section : undefined;
}

function TenantNavigation({ tenantId, route }: { tenantId: string; route: AppRoute }) {
  const groups: NavGroup[] = [
    { label: "Overview", items: [{ label: "Dashboard", href: tenantHref(tenantId, "overview"), section: "overview", icon: "home" }] },
    { label: "Applications", items: [{ label: "App Groups", href: tenantHref(tenantId, "app-groups"), section: "app-groups", icon: "app-group" }] },
    { label: "Storage & Networking", items: [
      { label: "Volumes", href: tenantHref(tenantId, "volumes"), section: "volumes", icon: "volume" },
      { label: "Registries", href: tenantHref(tenantId, "registries"), section: "registries", icon: "registry" },
      { label: "Domains", href: tenantHref(tenantId, "domains"), section: "domains", icon: "domain" },
    ] },
    { label: "Billing", items: [{ label: "Billing & quota", href: tenantHref(tenantId, "billing"), section: "billing", icon: "billing" }] },
    { label: "Access", items: [
      { label: "People & access", href: tenantHref(tenantId, "administration"), section: "administration", icon: "access" },
      { label: "Machine credentials", href: tenantHref(tenantId, "credentials"), section: "credentials", icon: "credential" },
    ] },
    { label: "Activity", items: [
      { label: "Operations", href: tenantHref(tenantId, "operations"), section: "operations", icon: "operation" },
      { label: "Audit log", href: tenantHref(tenantId, "audit"), section: "audit", icon: "audit" },
    ] },
  ];
  const current = activeSection(route);

  return <nav className="rp-workspace-nav" aria-label="Workspace">
    {groups.map((group) => <div className="rp-nav-group" key={group.label}>
      <p className="rp-nav-group-label">{group.label}</p>
      <div className="rp-nav-items">{group.items.map((item) => <a className="rp-nav-link" data-active={current === item.section || undefined} aria-current={current === item.section ? "page" : undefined} href={item.href} key={item.section}><ResourceIcon name={item.icon} className="rp-nav-icon" />{item.label}</a>)}</div>
    </div>)}
  </nav>;
}

function PlatformNavigation({ route }: { route: AppRoute }) {
  const items: NavItem[] = [
    { label: "Overview", href: "/platform/overview", section: "overview", icon: "platform" },
    { label: "Maintenance", href: "/platform/maintenance", section: "maintenance", icon: "operation" },
    { label: "Infrastructure", href: "/platform/infrastructure", section: "infrastructure", icon: "platform" },
    { label: "Identity providers", href: "/platform/identity-providers", section: "identity-providers", icon: "access" },
    { label: "Credentials", href: "/platform/credentials", section: "credentials", icon: "credential" },
    { label: "Billing", href: "/platform/billing", section: "billing", icon: "billing" },
  ];
  const current = route.kind === "platform" ? route.section : undefined;
  return <nav className="rp-platform-nav" aria-label="Platform administration">
    <p className="rp-nav-group-label">Platform Admin</p>
    <div className="rp-nav-items">{items.map((item) => <a className="rp-nav-link" data-active={route.kind === "platform" && current === item.section || undefined} aria-current={route.kind === "platform" && current === item.section ? "page" : undefined} href={item.href} key={item.section}><ResourceIcon name={item.icon} className="rp-nav-icon" />{item.label}</a>)}</div>
  </nav>;
}

const tenantSectionLabels: Record<string, string> = {
  overview: "Overview",
  "app-groups": "App Groups",
  volumes: "Volumes",
  registries: "Registries",
  domains: "Domains",
  billing: "Billing & quota",
  administration: "People & access",
  credentials: "Machine credentials",
  operations: "Operations",
  audit: "Audit log",
};

const platformSectionLabels: Record<string, string> = {
  overview: "Overview",
  maintenance: "Maintenance",
  infrastructure: "Infrastructure",
  "identity-providers": "Identity providers",
  credentials: "Credentials",
  billing: "Billing",
};

function BreadcrumbTrail({ route }: { route: AppRoute }) {
  if (route.kind === "tenant") {
    const sectionLabel = tenantSectionLabels[route.section] ?? route.section;
    return <nav className="rp-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/tenants">Tenants</a></li>
        <li><a href={tenantHref(route.tenantId, "overview")}>{route.tenantId}</a></li>
        <li aria-current={route.resourceId ? undefined : "page"}>{sectionLabel}</li>
        {route.resourceId ? <li aria-current="page">{route.resourceId}</li> : null}
      </ol>
    </nav>;
  }
  if (route.kind === "platform") {
    return <nav className="rp-breadcrumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/platform/overview">Platform</a></li>
        <li aria-current={route.resourceId ? undefined : "page"}>{platformSectionLabels[route.section] ?? route.section}</li>
        {route.resourceId ? <li aria-current="page">{route.resourceId}</li> : null}
      </ol>
    </nav>;
  }
  return null;
}

export function AppShell({ user, route, showPlatformAdmin = false, onLogout, children }: { user: ShellUser; route: AppRoute; showPlatformAdmin?: boolean; onLogout: () => void; children: ReactNode }) {
  const tenantId = route.kind === "tenant" ? route.tenantId : undefined;
  return <div className="rp-shell">
    <aside className="rp-sidebar">
      <div className="rp-brand"><span className="rp-brand-mark">R</span><div><strong>ResourcePortal</strong><span>Control Center</span></div></div>
      <a className="rp-tenant-switcher" href="/tenants"><ResourceIcon name="tenant" className="rp-tenant-switcher-icon" /><span><small>Workspace</small><strong>{tenantId ?? "Choose tenant"}</strong></span></a>
      {tenantId ? <TenantNavigation tenantId={tenantId} route={route} /> : null}
      {showPlatformAdmin || route.kind === "platform" ? <PlatformNavigation route={route} /> : null}
      <div className="rp-sidebar-footer"><a href="/health">System status</a></div>
    </aside>
    <div className="rp-shell-main">
      <header className="rp-topbar">
        <div className="rp-mobile-brand"><span className="rp-brand-mark">R</span><strong>ResourcePortal</strong></div>
        <div className="rp-topbar-context"><span>{route.kind === "platform" ? "Platform administration" : tenantId ? "Tenant workspace" : "ResourcePortal"}</span></div>
        <div className="rp-user-menu"><span className="rp-user-avatar" aria-hidden="true">{initials(user)}</span><div className="rp-user-copy"><strong>{user.displayName ?? user.email ?? user.id}</strong>{user.email && user.displayName ? <span>{user.email}</span> : null}</div><button className="rp-quiet-button" type="button" onClick={onLogout}>Sign out</button></div>
      </header>
      <div className="rp-shell-workspace"><BreadcrumbTrail route={route} /><div className="rp-content">{children}</div></div>
    </div>
  </div>;
}
