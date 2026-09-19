import { useEffect, useState } from "react";
import { apiRequest } from "../api/client";
import { ActivityIcon, Button, Callout, Card, CheckIcon, GridIcon, LockIcon, ResourcePortalLogo, ServerIcon, SettingsIcon, StatusBadge } from "../components/design-system";
import { AuthWorkspaceLayout } from "../components/auth-workspace";

function providerItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["providers", "items", "data"]) if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

export function AuthPage({ mode }: { mode: "login" | "register" | "recover" }) {
  const tenantId = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("tenantId") ?? "";
  const [providers, setProviders] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let active = true;
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
    setLoading(true);
    apiRequest(`/api/auth/providers${query}`).then((result) => {
      if (active) { setProviders(providerItems(result)); setError(undefined); }
    }).catch((cause) => { if (active) setError(cause); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tenantId]);

  function start(identityProviderId?: string) {
    const query = new URLSearchParams();
    if (tenantId) query.set("tenantId", tenantId);
    if (identityProviderId) query.set("identityProviderId", identityProviderId);
    window.location.assign(`/api/auth/${mode}${query.size ? `?${query}` : ""}`);
  }

  const isLogin = mode === "login";
  const heading = isLogin ? "Sign in to ResourcePortal" : mode === "register" ? "Create your ResourcePortal account" : "Recover ResourcePortal access";
  const intro = isLogin ? "Continue with your organization account to access ResourcePortal." : mode === "register" ? "Continue with your organization account to create access to ResourcePortal." : "Continue with your organization account to recover access to ResourcePortal.";
  const welcome = isLogin ? "Welcome back" : mode === "register" ? "Create access" : "Restore access";
  const welcomeBody = isLogin ? "ResourcePortal uses organization-managed SSO." : "Authentication is handled by your organization identity provider.";

  return <AuthWorkspaceLayout
    title={<>Stay in control of<br/>your infrastructure.</>}
    description="ResourcePortal brings your infrastructure into one clear place, so you can see what matters and act with confidence."
    features={[
      { icon: <GridIcon size={15}/>, title: "One clear view", description: "See applications, storage and services at a glance." },
      { icon: <SettingsIcon size={15}/>, title: "Simple control", description: "Manage everyday infrastructure without unnecessary complexity." },
      { icon: <ActivityIcon size={15}/>, title: "Stay informed", description: "Keep resources, access and activity easy to understand." },
    ]}
    headerAction={<a className="whitespace-nowrap text-sm font-medium text-[#526070] hover:text-[#0F56A7] hover:underline" href="/health">System status</a>}
    contentPlacement="center"
    contentWidthClassName="max-w-[520px]"
  >
    <div className="min-w-0">
      <div className="mb-3 min-w-0">
        <h2 className="text-[18px] font-semibold leading-[30px] text-[#172033]">{welcome}</h2>
        <p className="break-words text-[13px] leading-6 text-[#5B6678]">{welcomeBody}</p>
      </div>

      <Card className="min-w-0 overflow-hidden p-6 shadow-[0_18px_48px_rgba(23,32,51,0.14)] sm:p-8 lg:p-10">
        <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#1769E0]">Secure sign-in</p>
        <h1 className="mt-3 break-words text-[28px] font-semibold leading-[34px] tracking-[-.025em] text-[#172033]">{heading}</h1>
        <p className="mt-6 break-words text-[14px] leading-5 text-[#5B6678]">{intro}</p>

        {tenantId ? <div className="mt-4 min-w-0"><Callout title="Organization-specific sign-in">This sign-in request is scoped to the selected organization.</Callout></div> : null}
        {error ? <div className="mt-4 min-w-0"><Callout tone="danger" title="Authentication providers unavailable">ResourcePortal could not load the configured sign-in providers. You can retry by reloading this page.</Callout></div> : null}

        <div className="mt-8 grid min-w-0 gap-2.5" aria-busy={loading}>
          {loading ? <div className="flex h-12 min-w-0 items-center rounded-md border border-[#D7E0EC] bg-[#F8FAFD] px-4 text-sm text-[#5B6678]">Loading sign-in options…</div> : providers.length === 0 ? <Button variant="primary" className="h-12 w-full min-w-0 justify-start" onClick={() => start()}><span className="min-w-0 flex-1 truncate text-left">Continue with SSO</span><span className="shrink-0" aria-hidden="true">→</span></Button> : <>{providers.map((provider,index)=>{const id=String(provider.id??provider.identityProviderId??"");const label=String(provider.name??provider.displayName??provider.label??(id||`Provider ${index+1}`));return <Button variant="primary" className="h-12 w-full min-w-0 justify-start" key={id||index} onClick={()=>start(id||undefined)}><LockIcon size={16} className="shrink-0"/><span className="min-w-0 flex-1 truncate text-left">Continue with {label}</span></Button>})}<Button className="h-12 w-full min-w-0" onClick={()=>start()}>Use organization SSO</Button></>}
        </div>

        <div className="mt-5 flex min-w-0 gap-3 rounded-md border border-[#C9DDF8] bg-[#F2F7FF] px-4 py-3 text-[12px] leading-[17px] text-[#42526B]"><LockIcon size={16} className="mt-0.5 shrink-0 text-[#172033]"/><span className="min-w-0 break-words">You’ll be redirected to your organization identity provider to complete sign-in securely.</span></div>
        <div className="mt-6 border-t border-[#E1E7F0] pt-4 text-center text-[12px] leading-5 text-[#8491A5]">Authentication credentials are never entered on this screen.</div>
      </Card>
    </div>
  </AuthWorkspaceLayout>;
}

type HealthProbe = {
  status?: string;
  service?: string;
  dependencies?: Record<string, unknown>;
};

function useHealthProbe(path: string, refreshKey: number) {
  const [data, setData] = useState<HealthProbe>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError(undefined);
    apiRequest<HealthProbe>(path)
      .then((value) => { if (active) setData(value); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, [path, refreshKey]);
  return { data, error, loading: !data && !error };
}

function probeHealthy(probe?: HealthProbe) {
  return String(probe?.status ?? "").toLowerCase() === "ok";
}

function HealthProbeRow({ title, description, path, probe, loading, error }: { title: string; description: string; path: string; probe?: HealthProbe; loading: boolean; error?: unknown }) {
  const healthy = probeHealthy(probe);
  return <div className="flex min-w-0 flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:px-6">
    <div className="flex min-w-0 flex-1 items-start gap-3.5">
      <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${error ? "bg-[#FFF0EE] text-[#C42B1C]" : healthy ? "bg-[#E9F7F0] text-[#137A4A]" : "bg-[#F0F4F9] text-[#66758A]"}`}>
        {healthy ? <CheckIcon size={17}/> : <ActivityIcon size={17}/>}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-[15px] font-semibold text-[#172033]">{title}</h2>
          <code className="rounded bg-[#F3F6FA] px-1.5 py-0.5 text-[11px] font-medium text-[#66758A]">{path}</code>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-[#5B6678]">{description}</p>
        {probe?.service ? <p className="mt-1 text-xs text-[#8A96A8]">Service: <span className="font-medium text-[#66758A]">{probe.service}</span></p> : null}
      </div>
    </div>
    <div className="shrink-0 sm:pl-4">
      {loading
        ? <StatusBadge tone="neutral">Checking</StatusBadge>
        : error
          ? <StatusBadge tone="danger">Unavailable</StatusBadge>
          : healthy
            ? <StatusBadge tone="success">Operational</StatusBadge>
            : <StatusBadge tone="warning">{probe?.status || "Unknown"}</StatusBadge>}
    </div>
  </div>;
}

export function PublicHealthPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const health = useHealthProbe("/api/health", refreshKey);
  const live = useHealthProbe("/api/health/live", refreshKey);
  const ready = useHealthProbe("/api/health/ready", refreshKey);
  const probes = [health, live, ready];
  const loading = probes.some((probe) => probe.loading);
  const hasError = probes.some((probe) => Boolean(probe.error));
  const allHealthy = !loading && !hasError && probes.every((probe) => probeHealthy(probe.data));
  const dependencies = ready.data?.dependencies ?? health.data?.dependencies ?? {};

  return <main className="min-h-screen bg-[#F4F7FB] px-4 py-8 sm:px-8 sm:py-10">
    <div className="mx-auto max-w-5xl">
      <div className="flex items-center justify-between gap-4">
        <ResourcePortalLogo/>
        <a className="text-sm font-semibold text-[#0F56A7] hover:underline" href="/login">Sign in</a>
      </div>

      <div className="mt-10 flex min-w-0 flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[#1769E0]">System status</p>
          <h1 className="mt-2 text-[30px] font-semibold tracking-[-0.025em] text-[#172033]">ResourcePortal status</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5B6678]">Live health checks for the ResourcePortal API and its required dependencies.</p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setRefreshKey((value) => value + 1)}>Refresh status</Button>
      </div>

      <Card className="mt-7 overflow-hidden">
        <div className="flex min-w-0 flex-col gap-4 border-b border-[#E1E7F0] px-5 py-6 sm:flex-row sm:items-center sm:px-6">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${hasError ? "bg-[#FFF0EE] text-[#C42B1C]" : allHealthy ? "bg-[#E9F7F0] text-[#137A4A]" : "bg-[#EEF3F9] text-[#66758A]"}`}>
            {allHealthy ? <CheckIcon size={22}/> : <ServerIcon size={22}/>}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-[#172033]">{hasError ? "Service health degraded" : loading ? "Checking service health" : allHealthy ? "All systems operational" : "Service health requires attention"}</h2>
              <StatusBadge tone={hasError ? "danger" : loading ? "neutral" : allHealthy ? "success" : "warning"}>
                {hasError ? "Degraded" : loading ? "Checking" : allHealthy ? "Operational" : "Attention"}
              </StatusBadge>
            </div>
            <p className="mt-1 text-sm text-[#5B6678]">{hasError ? "One or more public health probes could not be reached." : allHealthy ? "The API is responding and required dependencies are available." : "ResourcePortal is evaluating the current service state."}</p>
          </div>
        </div>

        <div className="divide-y divide-[#E1E7F0]">
          <HealthProbeRow title="Health" description="Combined API and dependency health check." path="/api/health" probe={health.data} loading={health.loading} error={health.error}/>
          <HealthProbeRow title="Liveness" description="Confirms that the API process is running and responding." path="/api/health/live" probe={live.data} loading={live.loading} error={live.error}/>
          <HealthProbeRow title="Readiness" description="Confirms that the API can serve traffic with required dependencies available." path="/api/health/ready" probe={ready.data} loading={ready.loading} error={ready.error}/>
        </div>

        <div className="border-t border-[#E1E7F0] bg-[#F8FAFD] px-5 py-5 sm:px-6">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-sm font-semibold text-[#172033]">Dependencies</h2>
              <p className="mt-1 text-xs text-[#718096]">Required services reported by the readiness probe.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.keys(dependencies).length
                ? Object.entries(dependencies).map(([name, value]) => {
                    const healthy = String(value).toLowerCase() === "ok";
                    return <span key={name} className="inline-flex items-center gap-2 rounded-md border border-[#D7E0EC] bg-white px-3 py-2 text-[13px] text-[#42526B]">
                      <span className={`h-2 w-2 rounded-full ${healthy ? "bg-[#20A464]" : "bg-[#D18B00]"}`} aria-hidden="true"/>
                      <span className="font-medium">{name === "postgres" ? "PostgreSQL" : name}</span>
                      <span className={healthy ? "text-[#137A4A]" : "text-[#9A6700]"}>{healthy ? "Operational" : String(value)}</span>
                    </span>;
                  })
                : <span className="text-xs text-[#8A96A8]">{loading ? "Checking dependencies…" : "No dependency status reported."}</span>}
            </div>
          </div>
        </div>
      </Card>

      <p className="mt-5 text-center text-xs text-[#8A96A8]">This page exposes service health only. No tenant or account data is shown.</p>
    </div>
  </main>;
}