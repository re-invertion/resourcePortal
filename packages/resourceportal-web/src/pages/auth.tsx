import { useEffect, useState } from "react";
import { apiRequest } from "../api/client";
import { ErrorState, ReadOnlyPanel } from "../components/resource";

function providerItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["providers", "items", "data"]) if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

export function AuthPage({ mode }: { mode: "login" | "register" | "recover" }) {
  const initialTenant = new URLSearchParams(location.search).get("tenantId") ?? "";
  const [tenantId, setTenantId] = useState(initialTenant);
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    apiRequest(`/api/auth/providers${query}`).then((result) => setProviders(providerItems(result))).catch(setError);
  }, [tenantId]);

  function start(identityProviderId?: string) {
    const query = new URLSearchParams();
    if (tenantId) query.set("tenantId", tenantId);
    if (identityProviderId) query.set("identityProviderId", identityProviderId);
    window.location.assign(`/api/auth/${mode}${query.size ? `?${query}` : ""}`);
  }

  const title = mode === "login" ? "Sign in" : mode === "register" ? "Create your account" : "Recover account";
  const subtitle = mode === "login" ? "Access your ResourcePortal workspace." : mode === "register" ? "Create an identity and continue to your workspace." : "Continue through the configured identity provider to recover access.";
  return (
    <main className="rp-auth-page">
      <section className="rp-auth-card">
        <div className="rp-auth-brand"><span className="rp-brand-mark">R</span><div><strong>ResourcePortal</strong><span>Control Center</span></div></div>
        <div className="rp-auth-heading"><p className="rp-eyebrow">Secure access</p><h1>{title}</h1><p>{subtitle}</p></div>
        <label className="rp-auth-tenant-field">Tenant ID <span>(optional)</span><input placeholder="Use when your organization requires tenant-specific login" value={tenantId} onChange={(event) => setTenantId(event.target.value)} /></label>
        {error ? <ErrorState error={error} /> : null}
        <div className="rp-provider-list">
          {providers.length === 0 ? <button className="rp-auth-primary" type="button" onClick={() => start()}>Continue with platform login</button> : providers.map((provider, index) => {
            const id = String(provider.id ?? provider.identityProviderId ?? "");
            const rawLabel = provider.name ?? provider.displayName ?? provider.label ?? (id || `Provider ${index + 1}`);
            const label = String(rawLabel);
            return <button className="rp-auth-primary" key={id || index} type="button" onClick={() => start(id || undefined)}>Continue with {label}</button>;
          })}
          {providers.length > 0 ? <button className="rp-auth-secondary" type="button" onClick={() => start()}>Use platform/default login</button> : null}
        </div>
        <nav className="rp-auth-links" aria-label="Account actions">
          <a href="/login">Login</a><a href="/register">Register</a><a href="/recover">Recover</a><a href="/health">Status</a>
        </nav>
      </section>
      <aside className="rp-auth-aside" aria-hidden="true"><div><span className="rp-auth-orbit" /><p>Run applications, storage and networking from one control plane.</p></div></aside>
    </main>
  );
}

export function PublicHealthPage() {
  return <main className="rp-public-status"><h1>ResourcePortal status</h1><ReadOnlyPanel title="Health" path="/api/health" /><ReadOnlyPanel title="Liveness" path="/api/health/live" /><ReadOnlyPanel title="Readiness" path="/api/health/ready" /><p><a href="/login">Sign in</a></p></main>;
}
