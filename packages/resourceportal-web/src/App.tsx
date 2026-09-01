import { useEffect, useMemo, useState } from "react";
import { ApiError, apiRequest } from "./api/client";
import { JsonPayloadForm } from "./components/forms";
import { ErrorState } from "./components/resource";
import { AuthPage, PublicHealthPage } from "./pages/auth";
import { PlatformPage } from "./pages/platform";
import { TenantPage } from "./pages/tenant";
import { AppRoute, navigate, parseRoute, tenantHref } from "./router/router";

type User = { id: string; email?: string; displayName?: string; status?: string };
type Tenant = { id: string; name?: string; displayName?: string; status?: string };

function useRoute() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(location.pathname));
  useEffect(() => {
    const listener = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", listener);
    return () => removeEventListener("popstate", listener);
  }, []);
  return route;
}

function tenantList(value: unknown): Tenant[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items as unknown[] : [];
  return list.filter((item): item is Tenant => !!item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string").map((item) => item as Tenant);
}

export function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null | undefined>();
  const [tenants, setTenants] = useState<Tenant[] | undefined>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (route.kind === "public" && route.page === "health") return;
    apiRequest<User>("/api/auth/me").then(setUser).catch((cause) => {
      if (cause instanceof ApiError && cause.status === 401) setUser(null);
      else { setError(cause); setUser(null); }
    });
  }, []);

  const reloadTenants = async () => {
    const result = await apiRequest("/api/tenants");
    setTenants(tenantList(result));
  };

  useEffect(() => { if (user) void reloadTenants().catch(setError); }, [user]);

  if (route.kind === "public" && route.page === "health") return <PublicHealthPage />;
  if (user === undefined) return <main><h1>Resource Portal</h1><p>Loading session…</p>{error ? <ErrorState error={error} /> : null}</main>;
  if (!user) {
    const mode = route.kind === "public" && route.page !== "health" ? route.page : "login";
    return <AuthPage mode={mode} />;
  }
  if (!tenants) return <main><h1>Resource Portal</h1><p>Loading tenants…</p>{error ? <ErrorState error={error} /> : null}</main>;

  if (route.kind === "tenants" || route.kind === "public" || route.kind === "not-found") return <TenantSelector tenants={tenants} reload={reloadTenants} />;
  return <Shell user={user} route={route}>{route.kind === "tenant" ? <TenantPage tenantId={route.tenantId} section={route.section} resourceId={route.resourceId} userId={user.id} /> : <PlatformPage section={route.section} resourceId={route.resourceId} />}</Shell>;
}

function TenantSelector({ tenants, reload }: { tenants: Tenant[]; reload: () => Promise<void> }) {
  const active = useMemo(() => tenants.filter((tenant) => tenant.status === undefined || tenant.status === "Active"), [tenants]);
  const [error, setError] = useState<unknown>();
  useEffect(() => { if (active.length === 1) navigate(tenantHref(active[0].id, "overview"), true); }, [active]);
  if (active.length === 1) return <main><h1>Resource Portal</h1><p>Opening tenant…</p></main>;
  return <main><h1>Choose tenant</h1>{error ? <ErrorState error={error} /> : null}{active.length === 0 ? <><p>No active tenant is available. Create one if your platform permissions allow it.</p><JsonPayloadForm submitLabel="Create tenant" initialValue={{ name: "" }} onSubmit={async (body) => { try { await apiRequest("/api/tenants", { method: "POST", body }); await reload(); } catch (cause) { setError(cause); } }} /></> : <ul>{active.map((tenant) => <li key={tenant.id}><a href={tenantHref(tenant.id, "overview")}>{tenant.displayName ?? tenant.name ?? tenant.id}</a></li>)}</ul>}<p><a href="/health">Public health</a></p></main>;
}

function Shell({ user, route, children }: { user: User; route: AppRoute; children: React.ReactNode }) {
  const tenantId = route.kind === "tenant" ? route.tenantId : undefined;
  const tenantSections = ["overview", "app-groups", "volumes", "registries", "domains", "administration", "credentials", "billing", "audit", "operations"];
  return <><header><strong>Resource Portal</strong> <span>{user.displayName ?? user.email ?? user.id}</span><button type="button" onClick={() => { void apiRequest("/api/auth/logout", { method: "POST" }).finally(() => navigate("/login", true)); }}>Logout</button></header><nav aria-label="Primary"><a href="/tenants">Tenants</a>{tenantId ? tenantSections.map((section) => <span key={section}> · <a href={tenantHref(tenantId, section)}>{section}</a></span>) : null}<span> · <a href="/platform/overview">platform</a></span><span> · <a href="/platform/maintenance">maintenance</a></span><span> · <a href="/platform/infrastructure">infrastructure</a></span><span> · <a href="/platform/identity-providers">platform IdPs</a></span><span> · <a href="/platform/credentials">platform credentials</a></span><span> · <a href="/platform/billing">platform billing</a></span></nav>{children}</>;
}
