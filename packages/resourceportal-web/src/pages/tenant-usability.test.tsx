import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenantPage } from "./tenant";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function mockAppGroupRequests() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/memberships")) return json([]);
    if (url.endsWith("/app-groups/ag1/stack-preview")) return new Response("services:\n  web:\n    image: nginx", { status: 200, headers: { "content-type": "text/plain" } });
    if (url.endsWith("/app-groups/ag1/single-apps")) return json([{ id: "app-1", name: "web", status: "Running" }]);
    if (url.endsWith("/app-groups/ag1/deployments")) return json([{ id: "dep-1", name: "release-1", status: "Succeeded" }]);
    if (url.endsWith("/single-apps/app-1/runtime-config")) return json({ desiredReplicas: 1, cpu: 0.1, memoryBytes: 134217728 });
    if (url.endsWith("/single-apps/app-1/http-endpoints")) return json([]);
    if (url.endsWith("/app-groups/ag1/variables") || url.endsWith("/app-groups/ag1/configs") || url.endsWith("/app-groups/ag1/secrets")) return json([]);
    if (url.endsWith("/app-groups/ag1")) return json({ id: "ag1", name: "demo", status: "Running" });
    if (url.endsWith("/deployments/dep-1") || url.endsWith("/deployments/dep-1/events")) return json({ id: "dep-1", status: "Succeeded" });
    return json([]);
  }));
}

describe("AppGroup task-oriented selection", () => {
  it("configures a SingleApp by selecting its visible row instead of entering an ID", async () => {
    mockAppGroupRequests();
    render(<TenantPage tenantId="t" section="app-groups" resourceId="ag1" userId="u" />);

    const appRow = await screen.findByRole("row", { name: /web/i });
    expect(screen.queryByLabelText("SingleApp ID")).toBeNull();

    fireEvent.click(within(appRow).getByRole("button", { name: "Configure" }));

    expect(await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === "Selected application: web")).toBeTruthy();
    expect(await screen.findByText("Runtime / resource configuration")).toBeTruthy();
  });


  it("manages SingleApp attachments by resource name without requiring an attachment ID", async () => {
    history.replaceState(null, "", "/tenants/t/app-groups/ag1");
    let detached = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/app-groups/ag1/stack-preview")) return new Response("services:\n  web:\n    image: nginx", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.endsWith("/app-groups/ag1/single-apps")) return json([{ id: "app-1", name: "web", status: "Running" }]);
      if (url.endsWith("/app-groups/ag1/deployments")) return json([]);
      if (url.endsWith("/single-apps/app-1/runtime-config")) return json({ desiredReplicas: 1, cpu: 0.1, memoryBytes: 134217728 });
      if (url.endsWith("/single-apps/app-1/http-endpoints")) return json([]);
      if (url.endsWith("/app-groups/ag1/variables")) return json([{ id: "var-1", name: "API_URL", attachments: detached ? [] : [{ id: "att-var-1", variableId: "var-1", singleAppId: "app-1", targetName: "API_URL" }] }]);
      if (url.endsWith("/app-groups/ag1/configs")) return json([{ id: "cfg-1", name: "nginx.conf", attachments: [] }]);
      if (url.endsWith("/app-groups/ag1/secrets")) return json([{ id: "sec-1", name: "DB_PASSWORD", attachments: [] }]);
      if (url.endsWith("/volumes")) return json([{ id: "vol-1", name: "data", attachments: [{ id: "att-vol-1", volumeId: "vol-1", singleAppId: "app-1", mountPath: "/data", mode: "RW" }] }]);
      if (url.endsWith("/variable-attachments/att-var-1") && method === "DELETE") { detached = true; return json({ deleted: true }); }
      if (url.endsWith("/app-groups/ag1")) return json({ id: "ag1", name: "demo", status: "Running" });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="app-groups" resourceId="ag1" userId="u" />);
    const appRow = await screen.findByRole("row", { name: /web/i });
    fireEvent.click(within(appRow).getByRole("button", { name: "Configure" }));

    expect(await screen.findByRole("heading", { name: "Attachments" })).toBeTruthy();
    expect(screen.getByText("API_URL → API_URL")).toBeTruthy();
    expect(screen.getByText("data → /data (RW)")).toBeTruthy();
    expect(screen.queryByLabelText("Attachment ID")).toBeNull();
    expect((screen.getByLabelText("Variable") as HTMLElement).tagName).toBe("SELECT");

    fireEvent.click(screen.getByRole("button", { name: "Detach variable API_URL" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/variable-attachments/att-var-1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("API_URL → API_URL")).toBeNull());
  });

  it("opens deployment details from the visible deployment row instead of an ID field", async () => {
    mockAppGroupRequests();
    render(<TenantPage tenantId="t" section="app-groups" resourceId="ag1" userId="u" />);

    const deploymentRow = await screen.findByRole("row", { name: /release-1/i });
    expect(screen.queryByLabelText("Deployment ID for detail/events")).toBeNull();

    fireEvent.click(within(deploymentRow).getByRole("button", { name: "View details" }));

    expect(await screen.findByText((_, element) => element?.tagName === "P" && element.textContent === "Selected deployment: release-1")).toBeTruthy();
    expect(await screen.findByText("Deployment detail")).toBeTruthy();
    expect(await screen.findByText("Deployment events")).toBeTruthy();
  });
});

describe("guided access and routing", () => {

  it("uses invitations for normal user onboarding instead of asking for a user ID", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/roles")) return json([{ id: "viewer", name: "Viewer" }]);
      if (url.endsWith("/invitations")) return json([]);
      if (url.endsWith("/groups")) return json([]);
      if (url.endsWith("/identity-providers")) return json([]);
      if (url.endsWith("/auth-policy")) return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="administration" userId="u" />);
    await screen.findByRole("heading", { name: "Tenant administration" });

    expect(screen.queryByRole("button", { name: "Create Membership" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Create Invitation" }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("User ID")).toBeNull();
  });

  it("keeps HTTP endpoint IDs out of normal domain creation and isolates manual assignment under Advanced", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/domains/custom-root-domains")) return json([]);
      if (url.endsWith("/domains")) return json([{ id: "domain-1", hostname: "app.example.com", tlsEnabled: true }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="domains" userId="u" />);
    await screen.findByRole("row", { name: /app\.example\.com/i });
    fireEvent.click(screen.getByRole("button", { name: "Create Domain" }));
    const createWorkspace = screen.getByLabelText("Create Domain");
    expect(within(createWorkspace).queryByLabelText("HTTP endpoint ID")).toBeNull();

    fireEvent.click(screen.getByText("Advanced endpoint assignment"));
    const advanced = screen.getByRole("group", { name: "Advanced endpoint assignment" });
    expect((within(advanced).getByLabelText("Domain") as HTMLElement).tagName).toBe("SELECT");
    expect(within(advanced).getByLabelText("HTTP endpoint ID")).toBeTruthy();
  });
});

describe("tenant action feedback", () => {
  it("reports singleton configuration saves without rendering a duplicate mutation result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/roles")) return json([]);
      if (url.endsWith("/invitations")) return json([]);
      if (url.endsWith("/groups")) return json([]);
      if (url.endsWith("/identity-providers")) return json([]);
      if (url.endsWith("/auth-policy") && method === "GET") return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      if (url.endsWith("/auth-policy") && method === "PATCH") return json({ allowPlatformLogin: false, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="administration" userId="u" />);
    await screen.findByRole("heading", { name: "Authentication policy" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Authentication policy saved"));
    expect(screen.getAllByText("Allow platform login").length).toBe(1);
  });

  it("offers audit export as a downloadable file instead of inline raw output", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.includes("/audit-log/export")) return new Response('[{"action":"quota.update"}]', { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/audit-log")) return json({ items: [] });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="audit" userId="u" />);
    await screen.findByRole("heading", { name: "Audit log" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const download = await screen.findByRole("link", { name: "Download audit export" });
    expect(download.getAttribute("download")).toBe("audit-log.json");
    expect(download.getAttribute("href")).toContain("data:application/json");
    expect(screen.queryByText("Export output")).toBeNull();
  });
});
