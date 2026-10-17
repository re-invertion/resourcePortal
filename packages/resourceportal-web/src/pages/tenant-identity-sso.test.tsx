import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantIdentitySsoPage } from "./tenant-identity-sso";

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

  it("opens confirmation before deleting a client", async () => {
    const requests = mockApi(true);
    render(<TenantIdentitySsoPage tenantId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete Existing?" })).toBeTruthy();
    expect(requests.mock.calls.some(([url, init]) => String(url).endsWith("/oauth-applications/app-1") &&
      (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });
});
