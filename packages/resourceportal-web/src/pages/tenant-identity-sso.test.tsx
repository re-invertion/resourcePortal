import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantIdentitySsoPage, tenantOidcLifecycle } from "./tenant-identity-sso";

const base = "/api/tenants/t1";
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function mockApi(active = false) {
  const requests = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/oidc-provider")) return reply({
      tenantId: "t1", status: active ? "Active" : "NotProvisioned",
      enabled: active, issuer: "https://sso.example.com", projectId: active ? "project-1" : null,
      grantsReconciledAt: active ? new Date().toISOString() : null,
    });
    if (path.endsWith("/oauth-applications") && init?.method === "POST")
      return reply({ id: "app-created", name: "Portal", clientId: "client-1", clientSecret: "secret-1" });
    if (path.endsWith("/oauth-applications"))
      return reply(active ? [{ id: "app-1", type: "Web", name: "Existing", clientId: "client-1", hasClientSecret: true, zitadelProjectId: "project-1" }] : []);
    if (path.endsWith("/oidc-provider/provision") && init?.method === "POST")
      return reply({ status: "PendingGrants", enabled: false });
    if (path.endsWith("/oauth-applications/app-1") && init?.method === "DELETE")
      return reply({ deleted: true });
    return reply({});
  });
  vi.stubGlobal("fetch", requests);
  return requests;
}
afterEach(() => vi.unstubAllGlobals());

describe("Tenant Identity & SSO", () => {
  it("never enables the client creation form before the IdP is active", async () => {
    const requests = mockApi(false);
    render(<TenantIdentitySsoPage tenantId="t1" />);
    expect(await screen.findByText("No OIDC applications registered.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create application" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No tenant OIDC application can be created/)).toBeTruthy();
    expect(requests.mock.calls.some(([url, options]) =>
      String(url).endsWith("/oauth-applications") && (options as RequestInit | undefined)?.method === "POST",
    )).toBe(false);
  });

  it("registers an OAuth client only after an active tenant IdP is verified", async () => {
    const requests = mockApi(true);
    render(<TenantIdentitySsoPage tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create application" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Application name" }), {
      target: { value: "Portal" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Redirect URI/ }), {
      target: { value: "https://portal.example.com/callback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Register client" }));
    await waitFor(() => expect(requests.mock.calls.some(([url, init]) =>
      String(url) === `${base}/oauth-applications` &&
      (init as RequestInit | undefined)?.method === "POST",
    )).toBe(true));
    expect(await screen.findByText("Save credentials now — shown once")).toBeTruthy();
    expect(screen.getByText("secret-1")).toBeTruthy();
  });


  it("keeps the rotated OAuth secret visible and alerts if audit persistence fails", async () => {
    mockApi(true);
    const fetcher = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetcher.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/oauth-applications/app-1/rotate-credentials") && init?.method === "POST") {
        return reply({ clientId: "client-1", clientSecret: "one-time-rotated", auditStatus: "Failed", persistenceStatus: "Succeeded" });
      }
      if (path.endsWith("/oidc-provider")) return reply({tenantId:"t1",status:"Active",enabled:true,projectId:"project-1"});
      if (path.endsWith("/oauth-applications")) return reply([{id:"app-1",name:"Existing",type:"Web",clientId:"client-1",hasClientSecret:true,zitadelProjectId:"project-1"}]);
      return reply([]);
    });
    render(<TenantIdentitySsoPage tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate secret" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate secret for Existing?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
    expect(await screen.findByText("one-time-rotated")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Persistence: Succeeded.*Audit: Failed/);
  });

  it("opens confirmation before deleting a client", async () => {
    const requests = mockApi(true);
    render(<TenantIdentitySsoPage tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete Existing?" })).toBeTruthy();
    expect(requests.mock.calls.some(([url, init]) => String(url).endsWith("/oauth-applications/app-1") &&
      (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });
});

describe("#399 §11 tenant-issued SSO lifecycle safety",()=>{
  it("rejects transition controls without a verified provider",()=>{
    const policy=tenantOidcLifecycle(undefined,0,false);
    expect(Object.values(policy).filter(x=>x===true)).toHaveLength(0);
    expect(policy.reason).toMatch(/not been verified/);
  });

  it("permits only legal transitions and blocks project deletion while clients exist",()=>{
    const active=tenantOidcLifecycle({status:"Active",projectId:"project-1",enabled:true},4,false);
    expect(active.disable).toBe(true);
    expect(active.delete).toBe(false);
    expect(active.provision).toBe(false);
    expect(active.activate).toBe(false);
    for (const state of ["PendingGrants","NeedsReconciliation","ReconciliationFailed"]) {
      const pending=tenantOidcLifecycle({status:state,projectId:"project-1",enabled:false},0,false);
      expect(pending.reconcile).toBe(true);
      expect(pending.activate).toBe(false);
      expect(pending.disable).toBe(true);
    }
    const activationFailed=tenantOidcLifecycle({status:"ActivationFailed",projectId:"project-1",enabled:false},0,false);
    expect(activationFailed.disable).toBe(true);
    expect(activationFailed.activate).toBe(false);
    expect(activationFailed.delete).toBe(false);
    expect(tenantOidcLifecycle({status:"ActivationFailed",projectId:null,enabled:false},0,false).disable).toBe(false);
    const disabling=tenantOidcLifecycle({status:"Disabling",projectId:"project-1",enabled:false},0,false);
    expect(disabling.disable).toBe(true);
    expect(disabling.reconcile).toBe(false);
    expect(disabling.delete).toBe(false);
    const reconciled=tenantOidcLifecycle({status:"GrantsReconciled",projectId:"project-1",enabled:false},0,false);
    expect(reconciled.activate).toBe(true);
    expect(reconciled.disable).toBe(true);
    expect(reconciled.delete).toBe(true);
    const notReady=tenantOidcLifecycle({status:"NotProvisioned",projectId:null,enabled:false},0,false);
    expect(notReady.provision).toBe(true);
    expect(notReady.delete).toBe(false);
  });

  it("visibly explains lifecycle restrictions instead of offering destructive shortcuts",async()=>{
    mockApi(true);
    render(<TenantIdentitySsoPage tenantId="t1"/>);
    expect(await screen.findByText(/outbound single sign-on for tenant applications/)).toBeTruthy();
    expect(screen.getByRole("link",{name:"Application SSO"}).getAttribute("aria-current")).toBe("page");
    const deleteButton=screen.getByRole("button",{name:"Delete provider"});
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Delete clients in Application SSO before requesting project deletion/)).toBeTruthy();
  });
});
