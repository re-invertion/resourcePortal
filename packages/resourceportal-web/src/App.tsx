import { useEffect, useMemo, useState } from "react";
import { ApiError, apiRequest } from "./api/client";
import { AuthWorkspaceLayout } from "./components/auth-workspace";
import { CreateResourceWorkspace } from "./components/create-resource";
import { Button, Card, ChevronRightIcon, EmptyState, GridIcon, LockIcon, PlusIcon, ResourcePortalLogo, SearchIcon, StatusBadge, UsersIcon } from "./components/design-system";
import { ErrorState } from "./components/resource";
import { AppShell } from "./components/shell";
import { AuthPage, PublicHealthPage } from "./pages/auth";
import { PlatformPage } from "./pages/platform";
import { InvitationPage } from "./pages/invitation";
import { TenantPage } from "./pages/tenant";
import { AppRoute, parseRoute, tenantHref } from "./router/router";

type User = { id: string; email?: string; displayName?: string; status?: string };
type Tenant = { id: string; name?: string; displayName?: string; status?: string };
type AppProps = { initialPath?: string };

function browserPath() { return typeof window === "undefined" ? "/" : window.location.pathname; }
function useRoute(initialPath?: string) { const pathname = initialPath ?? browserPath(); return useMemo(() => parseRoute(pathname), [pathname]); }
function routeAttributes(route: AppRoute) { const attributes: Record<string, string> = { "data-route-kind": route.kind }; if (route.kind === "tenant") { attributes["data-tenant-id"] = route.tenantId; attributes["data-route-section"] = route.section; } else if (route.kind === "platform") attributes["data-route-section"] = route.section; else if (route.kind === "public") attributes["data-route-page"] = route.page; return attributes; }
function routeLoadingText(route: AppRoute) { if (route.kind === "tenant") return `Loading tenant route: ${route.section}…`; if (route.kind === "platform") return `Loading platform route: ${route.section}…`; if (route.kind === "invitation") return "Loading invitation…"; if (route.kind === "tenants") return "Loading tenants…"; if (route.kind === "not-found") return "Loading route…"; return "Loading session…"; }
function tenantList(value: unknown): Tenant[] { const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items as unknown[] : []; return list.filter((item): item is Tenant => !!item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string").map((item) => item as Tenant); }

function AppLoading({ route, error }: { route: AppRoute; error?: unknown }) {
  return <main {...routeAttributes(route)} className="flex min-h-screen items-center justify-center bg-[#F4F7FB] p-5"><Card className="w-full max-w-md p-6"><ResourcePortalLogo/><h1 className="mt-6 text-xl font-semibold">ResourcePortal</h1><p className="mt-2 text-sm text-[#5B6678]">{routeLoadingText(route)}</p>{error ? <div className="mt-4"><ErrorState error={error}/></div> : null}</Card></main>;
}

export function App({ initialPath }: AppProps = {}) {
  const route = useRoute(initialPath);
  const [user, setUser] = useState<User | null | undefined>();
  const [tenants, setTenants] = useState<Tenant[] | undefined>();
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => { if (route.kind === "public" && route.page === "health") return; apiRequest<User>("/api/auth/me").then(setUser).catch((cause) => { if (cause instanceof ApiError && cause.status === 401) setUser(null); else { setError(cause); setUser(null); } }); }, []);
  const reloadTenants = async () => { const result = await apiRequest("/api/tenants"); setTenants(tenantList(result)); };
  useEffect(() => { if (user) void reloadTenants().catch(setError); }, [user]);
  useEffect(() => { if (!user || (route.kind !== "tenant" && route.kind !== "platform")) { setPlatformAdmin(false); return; } let active = true; apiRequest("/api/platform/maintenance").then(() => { if (active) setPlatformAdmin(true); }).catch(() => { if (active) setPlatformAdmin(false); }); return () => { active = false; }; }, [user, route.kind]);
  if (route.kind === "public" && route.page === "health") return <PublicHealthPage />;
  if (user === undefined) return <AppLoading route={route} error={error}/>;
  if (!user) { if (route.kind === "invitation") return <InvitationPage token={route.token} user={null} />; const mode = route.kind === "public" && route.page !== "health" ? route.page : "login"; return <AuthPage mode={mode} />; }
  if (route.kind === "invitation") return <InvitationPage token={route.token} user={user} />;
  if (!tenants) return <AppLoading route={route} error={error}/>;
  if (route.kind === "not-found") return <main className="min-h-screen bg-[#F4F7FB] p-6" {...routeAttributes(route)}><div className="mx-auto max-w-2xl"><ResourcePortalLogo/><h1 className="sr-only">Page not found</h1><Card className="mt-8 p-6"><EmptyState title="Page not found" description="The requested ResourcePortal page does not exist." action={<a className="text-sm font-semibold text-[#0F56A7] hover:underline" href="/tenants">Choose tenant</a>}/></Card></div></main>;
  if (route.kind === "tenants" || route.kind === "public") return <TenantSelector user={user} tenants={tenants} reload={reloadTenants} />;
  return <AppShell user={user} route={route} tenants={tenants} showPlatformAdmin={platformAdmin} onLogout={() => { void apiRequest("/api/auth/logout", { method: "POST" }).finally(() => window.location.assign("/login")); }}>{route.kind === "tenant" ? <TenantPage tenantId={route.tenantId} section={route.section} resourceId={route.resourceId} segments={route.segments ?? []} userId={user.id} /> : <PlatformPage section={route.section} resourceId={route.resourceId} segments={route.segments ?? []} />}</AppShell>;
}

function TenantSelector({ user, tenants, reload }: { user: User; tenants: Tenant[]; reload: () => Promise<void> }) {
  const active = useMemo(() => tenants.filter((tenant) => tenant.status === undefined || tenant.status === "Active"), [tenants]);
  const [error, setError] = useState<unknown>();
  const [createOpen, setCreateOpen] = useState(active.length === 0);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return active;
    return active.filter((tenant) => (tenant.displayName ?? tenant.name ?? tenant.id).toLowerCase().includes(needle));
  }, [active, query]);
  const signOut = () => { void apiRequest("/api/auth/logout", { method: "POST" }).finally(() => window.location.assign("/login")); };

  return <AuthWorkspaceLayout
    title="One place for every workspace."
    description="Choose the tenant you want to manage while ResourcePortal keeps each workspace isolated and clear."
    features={[
      { icon: <GridIcon size={15}/>, title: "One clear view", description: "Move between tenant workspaces without losing context." },
      { icon: <LockIcon size={15}/>, title: "Safe tenant isolation", description: "Applications, storage and networking stay scoped to the selected tenant." },
      { icon: <UsersIcon size={15}/>, title: "Access that fits your role", description: "Only workspaces available to the signed-in account are shown." },
    ]}
    headerAction={<a className="whitespace-nowrap text-sm font-medium text-[#526070] hover:text-[#0F56A7] hover:underline" href="/health">System status</a>}
    contentPlacement="top"
    contentWidthClassName="max-w-[800px]"
  >
    <div className="min-w-0">
      <div className="flex min-w-0 flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <h1 className="break-words text-[30px] font-semibold tracking-[-.025em] text-[#172033]">Choose a tenant</h1>
          <p className="mt-1 break-words text-sm text-[#5B6678]">Select the workspace you want to manage.</p>
        </div>
        {active.length ? <Button variant="primary" className="max-w-full shrink-0" onClick={() => setCreateOpen(true)}><PlusIcon size={16}/>Create tenant</Button> : null}
      </div>

      {error ? <div className="mt-5 min-w-0"><ErrorState error={error}/></div> : null}

      {createOpen ? <div className="mt-6 min-w-0"><CreateResourceWorkspace title="Tenants" initialValue={{ name: "", displayName: "", description: "", contactEmail: "" }} onCancel={() => setCreateOpen(false)} onCreate={async (body) => { setError(undefined); try { await apiRequest("/api/tenants", { method: "POST", body }); await reload(); setCreateOpen(false); } catch (cause) { setError(cause); throw cause; } }} /></div> : active.length ? <>
        <label className="relative mt-7 block min-w-0">
          <span className="sr-only">Search tenants</span>
          <SearchIcon size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#718096]"/>
          <input type="search" aria-label="Search tenants" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tenants..." className="h-10 w-full min-w-0 rounded-md border border-[#B9C5D6] bg-white pl-10 pr-3 text-sm text-[#172033] outline-none focus:border-[#1769E0] focus:ring-2 focus:ring-[#1769E0]/15"/>
        </label>

        <div className="mt-7 min-w-0">
          <h2 className="text-sm font-semibold text-[#42526B]">Your tenants</h2>
          <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-[#D7E0EC] bg-white">
            {filtered.length ? filtered.map((tenant) => {
              const name = tenant.displayName ?? tenant.name ?? tenant.id;
              return <a className="group flex min-w-0 items-center gap-3 border-b border-[#E1E7F0] px-4 py-4 last:border-b-0 hover:bg-[#F8FAFD] sm:gap-4" key={tenant.id} href={tenantHref(tenant.id, "overview")}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#E7F1FF] text-[#1769E0]"><GridIcon size={18}/></span>
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-[#172033]" title={name}>{name}</strong>
                  <div className="mt-1"><StatusBadge tone="success">{tenant.status ?? "Active"}</StatusBadge></div>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-[#0F56A7]"><span className="hidden sm:inline">Open</span><ChevronRightIcon size={16}/></span>
              </a>;
            }) : <div className="px-5 py-8 text-center text-sm text-[#5B6678]">No tenants match your search.</div>}
          </div>
        </div>
      </> : <div className="mt-7 min-w-0"><EmptyState title="No active tenant" description="Create a tenant to establish an isolated workspace for applications, identities, storage and networking." action={<Button variant="primary" onClick={() => setCreateOpen(true)}>Create Tenant</Button>} /></div>}

      <div className="mt-10 flex min-w-0 flex-col justify-between gap-3 border-t border-[#E1E7F0] pt-5 text-sm sm:flex-row sm:items-center">
        <span className="min-w-0 text-[#718096]">Signed in as <strong className="break-all font-medium text-[#42526B]">{user.email ?? user.displayName ?? user.id}</strong></span>
        <Button size="sm" variant="ghost" className="shrink-0" onClick={signOut}>Sign out</Button>
      </div>
    </div>
  </AuthWorkspaceLayout>;
}
