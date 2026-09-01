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

  return (
    <main>
      <h1>Resource Portal</h1>
      <h2>{mode === "login" ? "Sign in" : mode === "register" ? "Register" : "Recover account"}</h2>
      <label>
        Tenant ID (optional)
        <input value={tenantId} onChange={(event) => setTenantId(event.target.value)} />
      </label>
      {error ? <ErrorState error={error} /> : null}
      <section>
        <h3>Identity providers</h3>
        {providers.length === 0 ? <p>No explicit provider returned. The platform login flow can select the default provider.</p> : (
          <ul>
            {providers.map((provider, index) => {
              const id = String(provider.id ?? provider.identityProviderId ?? "");
              const rawLabel = provider.name ?? provider.displayName ?? provider.label ?? (id || `Provider ${index + 1}`);
              const label = String(rawLabel);
              return <li key={id || index}><button type="button" onClick={() => start(id || undefined)}>{label}</button></li>;
            })}
          </ul>
        )}
        <button type="button" onClick={() => start()}>Continue with platform/default login</button>
      </section>
      <nav aria-label="Account actions">
        <a href="/login">Login</a>{" · "}<a href="/register">Register</a>{" · "}<a href="/recover">Recover</a>{" · "}<a href="/health">Health</a>
      </nav>
    </main>
  );
}

export function PublicHealthPage() {
  return <main><h1>Resource Portal status</h1><ReadOnlyPanel title="Health" path="/api/health" /><ReadOnlyPanel title="Liveness" path="/api/health/live" /><ReadOnlyPanel title="Readiness" path="/api/health/ready" /><p><a href="/login">Sign in</a></p></main>;
}
