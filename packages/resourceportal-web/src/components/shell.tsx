import { useState, type ReactNode } from "react";
import type { AppRoute } from "../router/router";
import { platformHref, tenantHref } from "../router/router";
import { ActivityIcon, BellIcon, BillingIcon, ChevronDownIcon, GridIcon, HelpIcon, HomeIcon, IconButton, KeyIcon, MenuIcon, NetworkIcon, ResourcePortalLogo, SearchIcon, SettingsIcon, UsersIcon, XIcon } from "./design-system";

type User = { id: string; email?: string; displayName?: string };

type NavItem = { label: string; href: string; icon: ReactNode; active: boolean };

function tenantItems(route: Extract<AppRoute, { kind: "tenant" }>): NavItem[] {
  const tenant = route.tenantId;
  const appActive = route.section === "applications" || route.section === "app-groups";
  const storageActive = ["storage-networking", "volumes", "registries", "domains"].includes(route.section);
  const accessActive = ["access", "administration", "credentials", "identity-providers", "groups"].includes(route.section);
  const activityActive = ["activity", "operations", "audit"].includes(route.section);
  return [
    { label: "Overview", href: tenantHref(tenant, "overview"), icon: <HomeIcon />, active: route.section === "overview" },
    { label: "Applications", href: tenantHref(tenant, "applications"), icon: <GridIcon />, active: appActive },
    { label: "Storage & Networking", href: tenantHref(tenant, "storage-networking"), icon: <NetworkIcon />, active: storageActive },
    { label: "Billing", href: tenantHref(tenant, "billing"), icon: <BillingIcon />, active: route.section === "billing" },
    { label: "Access", href: tenantHref(tenant, "access"), icon: <UsersIcon />, active: accessActive },
    { label: "Activity", href: tenantHref(tenant, "activity"), icon: <ActivityIcon />, active: activityActive },
  ];
}

function platformItems(route: Extract<AppRoute, { kind: "platform" }>): NavItem[] {
  return [
    { label: "Overview", href: platformHref("overview"), icon: <HomeIcon />, active: route.section === "overview" },
    { label: "Tenants", href: platformHref("tenants"), icon: <UsersIcon />, active: route.section === "tenants" },
    { label: "Infrastructure", href: "/platform/infrastructure/storage-backends", icon: <NetworkIcon />, active: ["infrastructure", "storage-backends"].includes(route.section) },
    { label: "Identity providers", href: platformHref("identity-providers"), icon: <UsersIcon />, active: ["identity", "identity-providers"].includes(route.section) },
    { label: "Credentials", href: platformHref("credentials"), icon: <KeyIcon />, active: route.section === "credentials" },
    { label: "Billing", href: platformHref("billing"), icon: <BillingIcon />, active: route.section === "billing" },
    { label: "Security & Ops", href: platformHref("security"), icon: <ActivityIcon />, active: ["security", "operations", "audit"].includes(route.section) },
    { label: "Maintenance", href: platformHref("maintenance"), icon: <SettingsIcon />, active: route.section === "maintenance" },
  ];
}

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return <a href={item.href} onClick={onNavigate} aria-current={item.active ? "page" : undefined} className={`relative flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium transition ${item.active ? "bg-[#E7F1FF] text-[#0F4F9B] before:absolute before:-left-2 before:h-7 before:w-[3px] before:rounded-full before:bg-[#1769E0]" : "text-[#263449] hover:bg-[#EEF3F9]"}`}><span className="shrink-0">{item.icon}</span><span className="truncate">{item.label}</span></a>;
}

function routeLabel(route: Extract<AppRoute, { kind: "tenant" | "platform" }>) {
  const section = route.section.replaceAll("-", " ");
  const display = section.replace(/\b\w/g, c => c.toUpperCase());
  if (route.kind === "tenant") return `Tenant / ${display === "App Groups" ? "Applications" : display}`;
  return `Platform Admin / ${display}`;
}

export function AppShell({ user, route, showPlatformAdmin = false, onLogout, children }: { user: User; route: Extract<AppRoute, { kind: "tenant" | "platform" }>; showPlatformAdmin?: boolean; onLogout: () => void; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = route.kind === "tenant" ? tenantItems(route) : platformItems(route);
  const userName = user.displayName || user.email || "Account";
  const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "RP";
  return <div className="rp-final-ui min-h-screen bg-[#F7F9FC] font-['Inter_Tight',Inter,ui-sans-serif,system-ui,sans-serif] text-[#172033]">
    <button type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)} className="fixed left-3 top-2.5 z-40 inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#D7E0EC] bg-white text-[#344054] lg:hidden"><MenuIcon /></button>
    {mobileOpen ? <button aria-label="Close navigation backdrop" className="fixed inset-0 z-40 bg-[#0E1A2B]/35 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[228px] flex-col border-r border-[#D7E0EC] bg-[#F4F7FB] px-3 pb-4 pt-3 transition-transform lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="mb-3 flex h-10 items-center justify-between px-2"><a href="/tenants" className="min-w-0"><ResourcePortalLogo /></a><IconButton label="Close navigation" className="lg:hidden" onClick={() => setMobileOpen(false)}><XIcon /></IconButton></div>
      <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-[#8A96A8]">{route.kind === "tenant" ? "Tenant" : "Platform"}</div>
      <nav aria-label="Workspace" className="space-y-1">{items.map(item => <NavLink key={item.href} item={item} onNavigate={() => setMobileOpen(false)} />)}</nav>
      {route.kind === "tenant" ? <div className="mt-5 border-t border-[#D7E0EC] pt-4"><div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-[#8A96A8]">Platform</div>{showPlatformAdmin ? <nav aria-label="Platform administration"><NavLink onNavigate={() => setMobileOpen(false)} item={{ label: "Platform Admin", href: platformHref("overview"), icon: <SettingsIcon />, active: false }} /></nav> : <p className="px-3 py-2 text-xs text-[#8A96A8]">Platform Admin access is not assigned.</p>}</div> : <div className="mt-5 border-t border-[#D7E0EC] pt-4"><a className="flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[#263449] hover:bg-[#EEF3F9]" href={tenantHref("", "overview").replace("/tenants//overview", "/tenants")}><GridIcon />Tenant workspaces</a></div>}
      <div className="mt-auto"><a href="/health" className="flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[#526070] hover:bg-[#EEF3F9]"><HelpIcon />Help</a></div>
    </aside>
    <div className="lg:pl-[228px]">
      <header className="sticky top-0 z-30 flex h-[58px] items-center border-b border-[#D7E0EC] bg-white px-4 pl-14 lg:px-6 lg:pl-6">
        <div className="min-w-0 flex-1 truncate text-[13px] text-[#42526B]">{routeLabel(route)}</div>
        <div className="hidden w-[292px] items-center rounded-md border border-[#C7D1DF] bg-[#F8FAFD] px-3 md:flex"><SearchIcon size={16} className="shrink-0 text-[#526070]"/><input aria-label="Search resources" placeholder="Search resources" className="h-9 min-w-0 flex-1 bg-transparent px-2 text-[13px] text-[#172033] outline-none placeholder:text-[#718096]" onKeyDown={event => { if (event.key === "Enter") { const value = event.currentTarget.value.trim().toLowerCase(); if (route.kind === "tenant") { const section = value.includes("volume") ? "volumes" : value.includes("domain") ? "domains" : value.includes("registr") ? "registries" : value.includes("bill") ? "billing" : value.includes("access") || value.includes("member") ? "access" : "applications"; window.location.assign(tenantHref(route.tenantId, section)); } } }} /></div>
        <div className="ml-3 flex items-center gap-1"><IconButton label="Notifications"><BellIcon /></IconButton><a href="/health" aria-label="Help" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#42526B] hover:bg-[#EEF3F9]"><HelpIcon /></a><details className="relative ml-1"><summary className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-full bg-[#F4F7FB] px-2.5 text-[13px] font-medium text-[#172033] hover:bg-[#EEF3F9]"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1769E0] text-[11px] font-semibold text-white">{initials}</span><span className="hidden max-w-28 truncate sm:block">{userName}</span><ChevronDownIcon size={14}/></summary><div className="absolute right-0 top-12 w-56 rounded-lg border border-[#D7E0EC] bg-white p-2 shadow-xl"><div className="border-b border-[#E1E7F0] px-2 py-2"><strong className="block truncate text-[13px]">{userName}</strong>{user.email ? <span className="block truncate text-xs text-[#718096]">{user.email}</span> : null}</div><button type="button" onClick={onLogout} className="mt-1 flex w-full items-center rounded-md px-2 py-2 text-left text-[13px] text-[#42526B] hover:bg-[#EEF3F9]">Sign out</button></div></details></div>
      </header>
      <div className="mx-auto w-full max-w-[1120px] px-4 py-5 sm:px-6 lg:px-7">{children}</div>
    </div>
  </div>;
}