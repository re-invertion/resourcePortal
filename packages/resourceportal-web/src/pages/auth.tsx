import { useEffect, useState, type ReactNode } from "react";
import { apiRequest } from "../api/client";
import { ActivityIcon, Button, Callout, Card, GridIcon, LockIcon, ResourcePortalLogo, SettingsIcon } from "../components/design-system";
import { ReadOnlyPanel } from "../components/resource";

function providerItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["providers", "items", "data"]) if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

function BrandFeature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="flex items-start gap-4">
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#EDF4FF] text-[#122033]">{icon}</div>
    <div><strong className="block text-[14px] font-semibold text-white">{title}</strong><p className="mt-1 max-w-[325px] text-[13px] leading-[18px] text-[#C6D5EA]">{children}</p></div>
  </div>;
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

  return <main className="min-h-screen bg-[#F7F9FC] lg:flex">
    <section className="relative hidden min-h-screen overflow-hidden bg-[#122033] px-12 py-[68px] lg:block lg:w-[552px] lg:shrink-0">
      <div className="pointer-events-none absolute left-[48px] top-[76px] h-[390px] w-[390px] rounded-full bg-[#17365E] opacity-80" aria-hidden="true" />
      <div className="pointer-events-none absolute bottom-[72px] right-[26px] h-[260px] w-[260px] rounded-full bg-[#18375F] opacity-70" aria-hidden="true" />
      <div className="relative z-10"><ResourcePortalLogo tone="inverse" /></div>
      <div className="relative z-10 mt-[106px]">
        <h2 className="max-w-[370px] text-[34px] font-semibold leading-[1.28] tracking-[-.025em] text-white">Stay in control of<br/>your infrastructure.</h2>
        <p className="mt-8 max-w-[350px] text-[15px] leading-[23px] text-[#D9E8FF]">ResourcePortal brings your infrastructure into one clear place, so you can see what matters and act with confidence.</p>
      </div>
      <div className="relative z-10 mt-14 space-y-5">
        <BrandFeature icon={<GridIcon size={15}/>} title="One clear view">See applications, storage and services at a glance.</BrandFeature>
        <BrandFeature icon={<SettingsIcon size={15}/>} title="Simple control">Manage everyday infrastructure without unnecessary complexity.</BrandFeature>
        <BrandFeature icon={<ActivityIcon size={15}/>} title="Stay informed">Keep resources, access and activity easy to understand.</BrandFeature>
      </div>
    </section>

    <section className="min-h-screen min-w-0 flex-1 bg-[#F7F9FC] px-5 py-10 sm:px-8 lg:px-10 lg:pb-16 lg:pt-[84px]">
      <div className="mx-auto w-full max-w-[440px]">
        <div className="mb-2">
          <h2 className="text-[18px] font-semibold leading-[30px] text-[#172033]">{welcome}</h2>
          <p className="text-[13px] leading-6 text-[#5B6678]">{welcomeBody}</p>
        </div>
        <Card className="min-h-[530px] p-6 shadow-[0_12px_30px_rgba(23,32,51,0.16)] sm:p-8 lg:p-12">
          <div className="mb-7"><ResourcePortalLogo /></div>
          <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-[#1769E0]">Secure sign-in</p>
          <h1 className="mt-3 text-[28px] font-semibold leading-[34px] tracking-[-.025em] text-[#172033]">{heading}</h1>
          <p className="mt-10 text-[14px] leading-5 text-[#5B6678]">{intro}</p>

          {tenantId ? <div className="mt-4"><Callout title="Organization-specific sign-in">This sign-in request is scoped to the selected organization.</Callout></div> : null}
          {error ? <div className="mt-4"><Callout tone="danger" title="Authentication providers unavailable">ResourcePortal could not load the configured sign-in providers. You can retry by reloading this page.</Callout></div> : null}

          <div className="mt-10 grid gap-2.5" aria-busy={loading}>
            {loading ? <div className="flex h-12 items-center rounded-md border border-[#D7E0EC] bg-[#F8FAFD] px-4 text-sm text-[#5B6678]">Loading sign-in options…</div> : providers.length === 0 ? <Button variant="primary" className="h-12 w-full" onClick={() => start()}><span>Continue with SSO</span><span className="ml-auto" aria-hidden="true">→</span></Button> : <>{providers.map((provider,index)=>{const id=String(provider.id??provider.identityProviderId??"");const label=String(provider.name??provider.displayName??provider.label??(id||`Provider ${index+1}`));return <Button variant="primary" className="h-12 w-full" key={id||index} onClick={()=>start(id||undefined)}><LockIcon size={16}/>Continue with {label}</Button>})}<Button className="h-12 w-full" onClick={()=>start()}>Use organization SSO</Button></>}
          </div>

          <div className="mt-5 flex gap-3 rounded-md border border-[#C9DDF8] bg-[#F2F7FF] px-4 py-3 text-[12px] leading-[17px] text-[#42526B]"><LockIcon size={16} className="mt-0.5 shrink-0 text-[#172033]"/><span>You’ll be redirected to your organization identity provider to complete sign-in securely.</span></div>
          <div className="mt-6 border-t border-[#E1E7F0] pt-4 text-center text-[12px] text-[#8491A5]">Authentication credentials are never entered on this screen.</div>
        </Card>
      </div>
    </section>
  </main>;
}

export function PublicHealthPage() {
  return <main className="min-h-screen bg-[#F4F7FB] px-4 py-10 sm:px-8"><div className="mx-auto max-w-4xl"><div className="mb-7 flex items-center justify-between"><ResourcePortalLogo/><a className="text-sm font-semibold text-[#0F56A7] hover:underline" href="/login">Sign in</a></div><div className="mb-5"><h1 className="text-2xl font-semibold">ResourcePortal status</h1><p className="mt-1 text-sm text-[#5B6678]">Public service health probes.</p></div><div className="grid gap-4 md:grid-cols-3"><ReadOnlyPanel title="Health" path="/api/health"/><ReadOnlyPanel title="Liveness" path="/api/health/live"/><ReadOnlyPanel title="Readiness" path="/api/health/ready"/></div></div></main>;
}