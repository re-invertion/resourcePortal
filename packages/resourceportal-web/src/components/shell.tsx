import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppRoute } from "../router/router";
import { apiRequest } from "../api/client";
import { RouteBreadcrumbs } from "./route-breadcrumbs";
import { applicationHref, appGroupHref, platformHref, tenantHref } from "../router/router";
import { ActivityIcon, BillingIcon, ChevronDownIcon, GlobeIcon, GridIcon, HelpIcon, HomeIcon, IconButton, KeyIcon, MenuIcon, NetworkIcon, ResourcePortalLogo, SearchIcon, SettingsIcon, UsersIcon, XIcon } from "./design-system";

type User = { id: string; email?: string; displayName?: string };
type NavItem = { label: string; href: string; icon: ReactNode; active: boolean };
type SearchItem = { id: string; label: string; description: string; href: string; category: string; keywords?: string };

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
    { label: "DNS & Domains", href: platformHref("dns"), icon: <GlobeIcon />, active: route.section === "dns" },
    { label: "Security & Ops", href: platformHref("security"), icon: <ActivityIcon />, active: ["security", "operations", "audit"].includes(route.section) },
    { label: "Maintenance", href: platformHref("maintenance"), icon: <SettingsIcon />, active: route.section === "maintenance" },
  ];
}

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return <a href={item.href} onClick={onNavigate} aria-current={item.active ? "page" : undefined} className={`relative flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium transition ${item.active ? "bg-[#E7F1FF] text-[#0F4F9B] before:absolute before:-left-2 before:h-7 before:w-[3px] before:rounded-full before:bg-[#1769E0]" : "text-[#263449] hover:bg-[#EEF3F9]"}`}><span className="shrink-0">{item.icon}</span><span className="truncate">{item.label}</span></a>;
}

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["items", "data", "results"]) {
    if (Array.isArray(object[key])) return records(object[key]);
  }
  return [];
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function idValue(item: Record<string, unknown>) {
  return stringValue(item.id);
}

function tenantSearchNavigation(tenantId: string): SearchItem[] {
  const item = (id: string, label: string, description: string, section: string, keywords = ""): SearchItem => ({
    id: `nav-${id}`, label, description, href: tenantHref(tenantId, section), category: "Navigation", keywords,
  });
  return [
    item("overview", "Overview", "Tenant dashboard and resource summary", "overview", "dashboard home"),
    item("applications", "Applications", "App Groups and deployed applications", "applications", "apps containers workloads app groups"),
    { id: "nav-create-app-group", label: "Create App Group", description: "Create a new deployment workspace", href: tenantHref(tenantId, "applications", "new"), category: "Action", keywords: "new application group create" },
    item("storage", "Storage & Networking", "Storage, registries and domains", "storage-networking", "network"),
    item("volumes", "Volumes", "Persistent tenant storage", "volumes", "disk storage persistent"),
    item("registries", "Registries", "Container image registries", "registries", "docker image registry"),
    item("domains", "Domains", "Managed and custom domains", "domains", "dns hostname tls"),
    item("billing", "Billing", "Credits, quota and vouchers", "billing", "credits voucher balance quota"),
    item("access", "Access", "Memberships and tenant access", "access", "users members permissions"),
    item("credentials", "Credentials", "Tenant credentials", "credentials", "keys secrets"),
    item("identity", "Identity providers", "Tenant SSO and identity providers", "identity-providers", "sso login authentication"),
    item("groups", "Groups", "Tenant identity groups", "groups", "users membership"),
    item("activity", "Activity", "Operations and audit activity", "activity", "events jobs"),
    item("operations", "Operations", "Runtime and background operations", "operations", "jobs deploy runtime"),
    item("audit", "Audit log", "Tenant audit history", "audit", "events history log"),
    item("help", "Help", "How to create apps, add domains, storage, billing and troubleshoot", "help", "guide docs documentation create app application domain volume registry deploy restart voucher billing troubleshoot"),
  ];
}

function platformSearchNavigation(): SearchItem[] {
  return [
    { id: "platform-overview", label: "Platform Overview", description: "Platform administration dashboard", href: platformHref("overview"), category: "Navigation", keywords: "dashboard home" },
    { id: "platform-tenants", label: "Tenants", description: "Manage tenant workspaces", href: platformHref("tenants"), category: "Navigation", keywords: "organizations workspaces" },
    { id: "platform-storage", label: "Storage backends", description: "Platform storage infrastructure", href: "/platform/infrastructure/storage-backends", category: "Navigation", keywords: "infrastructure storage" },
    { id: "platform-identity", label: "Identity providers", description: "Platform authentication providers", href: platformHref("identity-providers"), category: "Navigation", keywords: "sso auth login" },
    { id: "platform-credentials", label: "Credentials", description: "Platform credentials", href: platformHref("credentials"), category: "Navigation", keywords: "keys secrets" },
    { id: "platform-billing", label: "Billing", description: "Vouchers, prices and credit adjustments", href: platformHref("billing"), category: "Navigation", keywords: "credits vouchers balance payments correction" },
    { id: "platform-dns", label: "DNS & Domains", description: "Cloudflare managed ResourcePortal domains", href: platformHref("dns"), category: "Navigation", keywords: "cloudflare dns managed domain hostname" },
    { id: "platform-security", label: "Security & Ops", description: "Security, operations and audit", href: platformHref("security"), category: "Navigation", keywords: "audit operations security" },
    { id: "platform-maintenance", label: "Maintenance", description: "Platform maintenance controls", href: platformHref("maintenance"), category: "Navigation", keywords: "system maintenance" },
  ];
}

function scoreSearch(item: SearchItem, query: string) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const label = item.label.toLowerCase();
  const category = item.category.toLowerCase();
  const description = item.description.toLowerCase();
  const keywords = (item.keywords ?? "").toLowerCase();
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (label.includes(q)) return 65;
  const tokens = q.split(/\s+/).filter(Boolean);
  const haystack = `${label} ${category} ${description} ${keywords}`;
  if (tokens.every(token => haystack.includes(token))) return 45 + tokens.length;
  if (description.includes(q) || keywords.includes(q)) return 35;
  return 0;
}

function QuickSearch({ route, showPlatformAdmin }: { route: Extract<AppRoute, { kind: "tenant" | "platform" }>; showPlatformAdmin: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [dynamicItems, setDynamicItems] = useState<SearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const loadedKeyRef = useRef("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const staticItems = useMemo(() => {
    const base = route.kind === "tenant" ? tenantSearchNavigation(route.tenantId) : platformSearchNavigation();
    if (route.kind === "tenant" && showPlatformAdmin) {
      return [...base, { id: "platform-admin", label: "Platform Admin", description: "Open platform administration", href: platformHref("overview"), category: "Navigation", keywords: "admin platform" }];
    }
    return base;
  }, [route, showPlatformAdmin]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (event.key === "Escape" && document.activeElement === inputRef.current) {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    function outside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", shortcut);
    document.addEventListener("mousedown", outside);
    return () => {
      window.removeEventListener("keydown", shortcut);
      document.removeEventListener("mousedown", outside);
    };
  }, []);

  async function loadDynamic() {
    const key = route.kind === "tenant" ? `tenant:${route.tenantId}` : "platform";
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    setLoading(true);
    try {
      if (route.kind === "platform") {
        const tenants = records(await apiRequest("/api/tenants"));
        setDynamicItems(tenants.map(tenant => ({
          id: `tenant-${idValue(tenant)}`,
          label: stringValue(tenant.displayName, stringValue(tenant.name, idValue(tenant))),
          description: stringValue(tenant.description, "Tenant workspace"),
          href: tenantHref(idValue(tenant), "overview"),
          category: "Tenant",
          keywords: `${stringValue(tenant.name)} ${stringValue(tenant.status)} ${stringValue(tenant.contactEmail)}`,
        })).filter(item => item.href && item.label));
        return;
      }

      const tenantId = route.tenantId;
      const base = `/api/tenants/${encodeURIComponent(tenantId)}`;
      const [groupPayload, volumePayload, registryPayload, domainPayload] = await Promise.all([
        apiRequest(`${base}/app-groups`).catch(() => []),
        apiRequest(`${base}/volumes`).catch(() => []),
        apiRequest(`${base}/registries`).catch(() => []),
        apiRequest(`${base}/domains`).catch(() => []),
      ]);
      const groups = records(groupPayload);
      const resources: SearchItem[] = [];

      for (const group of groups) {
        const groupId = idValue(group);
        if (!groupId) continue;
        const groupName = stringValue(group.displayName, stringValue(group.name, groupId));
        resources.push({
          id: `group-${groupId}`, label: groupName, description: "App Group", href: appGroupHref(tenantId, groupId), category: "App Group",
          keywords: `${stringValue(group.description)} ${stringValue(group.runtimeState)} ${stringValue(group.health)}`,
        });
      }

      const appsByGroup = await Promise.all(groups.slice(0, 30).map(async group => {
        const groupId = idValue(group);
        if (!groupId) return [] as SearchItem[];
        const groupName = stringValue(group.displayName, stringValue(group.name, groupId));
        const apps = records(await apiRequest(`${base}/app-groups/${encodeURIComponent(groupId)}/single-apps`).catch(() => []));
        return apps.map(app => {
          const appId = idValue(app);
          return {
            id: `app-${groupId}-${appId}`,
            label: stringValue(app.displayName, stringValue(app.name, appId)),
            description: `Application in ${groupName}`,
            href: applicationHref(tenantId, groupId, appId),
            category: "Application",
            keywords: `${stringValue(app.image)} ${stringValue(app.runtimeState)} ${stringValue(app.health)} ${groupName}`,
          } satisfies SearchItem;
        }).filter(item => item.id && item.label);
      }));
      resources.push(...appsByGroup.flat());

      for (const [category, payload, section, keywords] of [
        ["Volume", volumePayload, "volumes", "storage disk persistent"],
        ["Registry", registryPayload, "registries", "docker image container"],
        ["Domain", domainPayload, "domains", "dns hostname tls"],
      ] as const) {
        for (const resource of records(payload)) {
          const id = idValue(resource);
          if (!id) continue;
          resources.push({
            id: `${category.toLowerCase()}-${id}`,
            label: stringValue(resource.displayName, stringValue(resource.name, stringValue(resource.hostname, id))),
            description: category,
            href: tenantHref(tenantId, section, id),
            category,
            keywords: `${keywords} ${stringValue(resource.description)} ${stringValue(resource.status)} ${stringValue(resource.host)} ${stringValue(resource.hostname)}`,
          });
        }
      }
      setDynamicItems(resources);
    } finally {
      setLoading(false);
    }
  }

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return staticItems.slice(0, 8);
    return [...staticItems, ...dynamicItems]
      .map(item => ({ item, score: scoreSearch(item, q) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
      .slice(0, 10)
      .map(result => result.item);
  }, [query, staticItems, dynamicItems]);

  useEffect(() => setSelected(0), [query, results.length]);

  function navigate(item: SearchItem) {
    setOpen(false);
    window.location.assign(item.href);
  }

  return <div ref={rootRef} className="relative min-w-0 flex-1 xl:flex-none">
    <div className={`flex h-9 w-full min-w-0 items-center rounded-md border bg-[#F8FAFD] px-3 transition xl:w-[460px] 2xl:w-[520px] ${open ? "border-[#1769E0] bg-white ring-2 ring-[#1769E0]/15" : "border-[#C7D1DF] hover:border-[#9EADBF]"}`}>
      <SearchIcon size={16} className="shrink-0 text-[#526070]" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search resources"
        aria-expanded={open}
        aria-controls="global-search-results"
        aria-autocomplete="list"
        value={query}
        placeholder="Search resources, apps, pages…"
        className="rp-global-search-input h-full min-w-0 flex-1 px-2 text-[13px] text-[#172033] placeholder:text-[#718096]"
        onFocus={() => { setOpen(true); void loadDynamic(); }}
        onChange={event => { setQuery(event.target.value); setOpen(true); void loadDynamic(); }}
        onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected(index => Math.min(index + 1, Math.max(results.length - 1, 0))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected(index => Math.max(index - 1, 0)); }
          if (event.key === "Enter" && results[selected]) { event.preventDefault(); navigate(results[selected]); }
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); inputRef.current?.blur(); }
        }}
      />
      <kbd className="hidden shrink-0 rounded border border-[#D7E0EC] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#718096] 2xl:inline">⌘K</kbd>
    </div>

    {open ? <div id="global-search-results" role="listbox" className="rp-search-results absolute left-0 right-0 top-[44px] z-[70] max-h-[min(420px,68vh)] overflow-y-auto rounded-xl border border-[#E3EAF3] bg-white/98 p-2 shadow-[0_14px_36px_rgba(15,23,42,0.14)] backdrop-blur-sm">
      <div className="flex items-center justify-between px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[#8A96A8]">
        <span>{query.trim() ? "Search results" : "Quick navigation"}</span>
        {loading ? <span className="normal-case font-medium tracking-normal text-[#718096]">Loading resources…</span> : null}
      </div>
      {results.length ? results.map((item, index) => <button
        key={item.id}
        type="button"
        role="option"
        aria-selected={index === selected}
        onMouseEnter={() => setSelected(index)}
        onMouseDown={event => event.preventDefault()}
        onClick={() => navigate(item)}
        className="rp-search-result flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#F4F8FD] text-[#1769E0]"><SearchIcon size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[#172033]">{item.label}</span>
          <span className="mt-0.5 block truncate text-[12px] text-[#66758A]">{item.description}</span>
        </span>
        <span className="shrink-0 rounded-full bg-[#F5F7FB] px-2 py-0.5 text-[10px] font-medium text-[#7B8798]">{item.category}</span>
      </button>) : <div className="px-4 py-10 text-center">
        <SearchIcon size={20} className="mx-auto text-[#A0AEC0]" />
        <p className="mt-2 text-sm font-medium text-[#42526B]">No matching resources</p>
        <p className="mt-1 text-xs text-[#8A96A8]">Try a page name, application, App Group, volume, registry or domain.</p>
      </div>}
      <div className="mt-2 hidden border-t border-[#EEF2F7] px-2 pt-2 text-[10px] text-[#8A96A8] sm:flex sm:items-center sm:gap-2">
        <span className="rounded bg-[#F6F8FB] px-1.5 py-0.5">↑↓ navigate</span><span className="rounded bg-[#F6F8FB] px-1.5 py-0.5">Enter open</span><span className="rounded bg-[#F6F8FB] px-1.5 py-0.5">Esc close</span>
      </div>
    </div> : null}
  </div>;
}

export function AppShell({ user, route, showPlatformAdmin = false, onLogout, children }: { user: User; route: Extract<AppRoute, { kind: "tenant" | "platform" }>; showPlatformAdmin?: boolean; onLogout: () => void; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = route.kind === "tenant" ? tenantItems(route) : platformItems(route);
  const userName = user.displayName || user.email || "Account";
  const initials = userName.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "RP";
  const helpHref = route.kind === "tenant" ? tenantHref(route.tenantId, "help") : "/health";
  const helpLabel = route.kind === "tenant" ? "Help" : "System status";

  return <div className="rp-final-ui min-h-screen w-full max-w-full overflow-x-hidden bg-[#F7F9FC] font-['Inter_Tight',Inter,ui-sans-serif,system-ui,sans-serif] text-[#172033]">
    <button type="button" aria-label="Open navigation" onClick={() => setMobileOpen(true)} className="fixed left-3 top-2.5 z-40 inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#D7E0EC] bg-white text-[#344054] lg:hidden"><MenuIcon /></button>
    {mobileOpen ? <button aria-label="Close navigation backdrop" className="fixed inset-0 z-40 bg-[#0E1A2B]/35 lg:hidden" onClick={() => setMobileOpen(false)} /> : null}
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[228px] flex-col border-r border-[#D7E0EC] bg-[#F4F7FB] px-3 pb-4 pt-3 transition-[transform,visibility] lg:pointer-events-auto lg:visible lg:translate-x-0 ${mobileOpen ? "pointer-events-auto visible translate-x-0" : "pointer-events-none invisible -translate-x-full"}`}>
      <div className="mb-3 flex h-10 items-center justify-between px-2"><a href="/tenants" className="min-w-0"><ResourcePortalLogo /></a><IconButton label="Close navigation" className="lg:hidden" onClick={() => setMobileOpen(false)}><XIcon /></IconButton></div>
      <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-[#8A96A8]">{route.kind === "tenant" ? "Tenant" : "Platform"}</div>
      <nav aria-label="Workspace" className="space-y-1">{items.map(item => <NavLink key={item.href} item={item} onNavigate={() => setMobileOpen(false)} />)}</nav>
      {route.kind === "tenant" ? <div className="mt-5 border-t border-[#D7E0EC] pt-4"><div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.04em] text-[#8A96A8]">Platform</div>{showPlatformAdmin ? <nav aria-label="Platform administration"><NavLink onNavigate={() => setMobileOpen(false)} item={{ label: "Platform Admin", href: platformHref("overview"), icon: <SettingsIcon />, active: false }} /></nav> : <p className="px-3 py-2 text-xs text-[#8A96A8]">Platform Admin access is not assigned.</p>}</div> : <div className="mt-5 border-t border-[#D7E0EC] pt-4"><a className="flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-[#263449] hover:bg-[#EEF3F9]" href="/tenants"><GridIcon />Tenant workspaces</a></div>}
      <div className="mt-auto"><a href={helpHref} aria-current={route.kind === "tenant" && route.section === "help" ? "page" : undefined} className={`flex h-10 items-center gap-3 rounded-md px-3 text-[13px] font-medium transition ${route.kind === "tenant" && route.section === "help" ? "bg-[#E7F1FF] text-[#0F4F9B]" : "text-[#526070] hover:bg-[#EEF3F9]"}`}><HelpIcon />{helpLabel}</a></div>
    </aside>

    <div className="min-w-0 lg:pl-[228px]">
      <header className="sticky top-0 z-30 h-[58px] min-w-0 border-b border-[#D7E0EC] bg-white">
        <div className="mx-auto grid h-full w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 pl-14 sm:gap-3 sm:px-4 sm:pl-14 lg:px-5 lg:pl-5 xl:grid-cols-[minmax(150px,1fr)_minmax(320px,520px)_minmax(150px,1fr)] xl:gap-4 2xl:grid-cols-[minmax(200px,1fr)_minmax(360px,560px)_minmax(200px,1fr)]">
          <div className="hidden min-w-0 xl:block"><RouteBreadcrumbs route={route} /></div>

          <div className="min-w-0 xl:col-start-2">
            <QuickSearch route={route} showPlatformAdmin={showPlatformAdmin} />
          </div>

          <div className="flex min-w-0 items-center justify-end gap-0.5 sm:gap-1 xl:col-start-3">
            <a href={helpHref} aria-label={helpLabel} title={helpLabel} className="hidden h-8 w-8 items-center justify-center rounded-md text-[#42526B] hover:bg-[#EEF3F9] sm:inline-flex"><HelpIcon /></a>
            <details className="relative ml-0.5 sm:ml-1">
              <summary className="flex h-9 max-w-[160px] cursor-pointer list-none items-center gap-2 rounded-full bg-[#F4F7FB] px-1.5 text-[13px] font-medium text-[#172033] hover:bg-[#EEF3F9] sm:h-10 sm:px-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1769E0] text-[11px] font-semibold text-white">{initials}</span>
                <span className="hidden min-w-0 max-w-24 truncate 2xl:block">{userName}</span>
                <ChevronDownIcon size={14} className="hidden shrink-0 sm:block" />
              </summary>
              <div className="absolute right-0 top-12 w-56 rounded-lg border border-[#D7E0EC] bg-white p-2 shadow-xl">
                <div className="border-b border-[#E1E7F0] px-2 py-2"><strong className="block truncate text-[13px]">{userName}</strong>{user.email ? <span className="block truncate text-xs text-[#718096]">{user.email}</span> : null}</div>
                <button type="button" onClick={onLogout} className="mt-1 flex w-full items-center rounded-md px-2 py-2 text-left text-[13px] text-[#42526B] hover:bg-[#EEF3F9]">Sign out</button>
              </div>
            </details>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full min-w-0 max-w-[1120px] px-4 py-5 sm:px-6 lg:px-7">{children}</div>
    </div>
  </div>;
}