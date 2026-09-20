import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantPage } from "./tenant";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function installAppGroupBase(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const override = extra?.(url, init);
    if (override) return override;
    if (url.endsWith("/memberships")) return json([]);
    if (url.endsWith("/app-groups/ag1")) return json({ id: "ag1", name: "demo", status: "Running", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync" });
    if (url.endsWith("/app-groups/ag1/single-apps")) return json([{ id: "app-1", name: "web", image: "nginx:latest", status: "Running", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy" }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppGroup task-oriented selection", () => {
  it("opens a SingleApp by its visible name instead of asking for an ID", async () => {
    installAppGroupBase();
    render(<TenantPage tenantId="t" section="app-groups" segments={["ag1", "apps"]} userId="u" />);

    const appRow = await screen.findByRole("row", { name: /web/i });
    expect(screen.queryByLabelText("SingleApp ID")).toBeNull();
    const appLink = within(appRow).getAllByRole("link").find(link => link.getAttribute("href") === "/tenants/t/app-groups/ag1/apps/app-1");
    expect(appLink).toBeTruthy();
  });

  it("uses resource names for attachments and refuses unsafe detach without attachment IDs", async () => {
    installAppGroupBase((url) => {
      if (url.endsWith("/single-apps/app-1/runtime-config")) return json({ desiredReplicas: 1, cpu: 0.1, memoryBytes: 134217728, environment: {} });
      if (url.endsWith("/single-apps/app-1/http-endpoints")) return json([]);
      if (url.endsWith("/registries")) return json([]);
      if (url.endsWith("/volumes")) return json([{ id: "vol-1", name: "data" }]);
      if (url.endsWith("/app-groups/ag1/variables")) return json([{ id: "var-1", name: "API_URL" }]);
      if (url.endsWith("/app-groups/ag1/configs")) return json([{ id: "cfg-1", name: "nginx.conf" }]);
      if (url.endsWith("/app-groups/ag1/secrets")) return json([{ id: "sec-1", name: "DB_PASSWORD" }]);
      return undefined;
    });

    render(<TenantPage tenantId="t" section="app-groups" segments={["ag1", "apps", "app-1", "edit", "configuration"]} userId="u" />);
    expect(await screen.findByRole("heading", { name: "web" })).toBeTruthy();

    expect(screen.queryByLabelText("Attachment ID")).toBeNull();
    const kind = screen.getByLabelText("Resource type") as HTMLSelectElement;
    await waitFor(() => expect(kind.value).toBe("variable"));
    const resource = screen.getByLabelText("Resource") as HTMLSelectElement;
    expect(resource.tagName).toBe("SELECT");
    expect(within(resource).getByRole("option", { name: "API_URL" })).toBeTruthy();
    expect(screen.getByText(/cannot be safely detached here without guessing identifiers/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /detach/i })).toBeNull();
  });

  it("opens deployment details from a readable deployment row instead of an ID field", async () => {
    installAppGroupBase((url) => {
      if (url.endsWith("/app-groups/ag1/deployments")) return json([{ id: "dep-1", name: "release-1", status: "Succeeded", createdAt: "2026-09-13T18:00:00.000Z" }]);
      if (url.endsWith("/deployments/dep-1/events")) return json([]);
      return undefined;
    });

    render(<TenantPage tenantId="t" section="app-groups" segments={["ag1", "deployments"]} userId="u" />);
    const deploymentRow = await screen.findByRole("row", { name: /release-1/i });
    expect(screen.queryByLabelText(/Deployment ID/i)).toBeNull();
    fireEvent.click(within(deploymentRow).getByRole("button", { name: "Inspect" }));
    expect(await screen.findByRole("heading", { name: "Deployment events" })).toBeTruthy();
    expect(screen.getAllByText("release-1").length).toBeGreaterThan(0);
  });
});

describe("guided access and routing", () => {
  it("keeps operation UUIDs out of the normal operations inventory", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/operations")) return json([{ id: operationId, type: "DOMAIN_VERIFY", status: "Succeeded", resourceType: "Domain", createdAt: "2026-09-14T08:00:00.000Z" }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="operations" userId="u" />);
    await screen.findByRole("row", { name: /DOMAIN VERIFY/i });

    expect(screen.queryByText(operationId)).toBeNull();
  });

  it("keeps operation UUIDs out of operation detail copy", async () => {
    const operationId = "22222222-2222-4222-8222-222222222222";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/operations/22222222-2222-4222-8222-222222222222/events")) return json([]);
      if (url.endsWith("/operations/22222222-2222-4222-8222-222222222222")) return json({ id: operationId, type: "VOLUME_RESIZE", status: "Succeeded", resourceType: "Volume", createdAt: "2026-09-14T08:00:00.000Z" });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<TenantPage tenantId="t" section="operations" resourceId={operationId} userId="u" />);
    await screen.findByRole("heading", { name: /VOLUME RESIZE/i });
    expect(screen.queryByText(new RegExp(operationId))).toBeNull();
  });

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
    await screen.findByRole("heading", { name: "Access management" });

    expect(screen.queryByRole("button", { name: "Create Membership" })).toBeNull();
    expect(screen.queryByLabelText("User ID")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Invite user" }));
    expect(screen.getByRole("textbox", { name: /Email/i })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: /Role/i }) as HTMLElement).tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "Viewer" })).toBeTruthy();
  });

  it("keeps backend endpoint IDs out of normal domain creation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/domains/custom-root-domains")) return json([]);
      if (url.endsWith("/domains/capabilities")) return json({ managedDomains: { enabled: true, provider: "Cloudflare", baseDomain: "resource-portal.pl" } });
      if (url.endsWith("/domains")) return json([{ id: "domain-1", hostname: "app.example.com", tlsEnabled: true }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="domains" userId="u" />);
    await screen.findByRole("row", { name: /app\.example\.com/i });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect(screen.getByRole("combobox", { name: /Domain type/i })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Prefix/i })).toBeTruthy();
    expect(screen.queryByLabelText("HTTP endpoint ID")).toBeNull();
  });
});

describe("tenant action feedback", () => {
  it("reports authentication policy saves from the final policy control", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/memberships")) return json([]);
      if (url.endsWith("/roles")) return json([]);
      if (url.endsWith("/invitations")) return json([]);
      if (url.endsWith("/groups")) return json([]);
      if (url.endsWith("/identity-providers")) return json([]);
      if (url.endsWith("/auth-policy") && method === "GET") return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      if (url.endsWith("/auth-policy") && method === "PATCH") return json({ allowPlatformLogin: true, allowTenantIdentityProviders: true, requireTenantIdentityProvider: false });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="administration" userId="u" />);
    await screen.findByRole("heading", { name: "Authentication policy" });
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Authentication policy saved"));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/auth-policy") && (init?.method ?? "GET") === "PATCH")).toBe(true);
  });

  it("offers audit export as direct backend downloads instead of inline raw output", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/memberships")) return json([]);
      if (url.includes("/audit-log?")) return json({ items: [] });
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TenantPage tenantId="t" section="audit" userId="u" />);
    await screen.findByRole("heading", { name: "Audit log" });
    const csv = screen.getByRole("link", { name: "Export CSV" });
    const jsonLink = screen.getByRole("link", { name: "Export JSON" });
    expect(csv.getAttribute("download")).toBe("audit-log.csv");
    expect(csv.getAttribute("href")).toContain("/api/tenants/t/audit-log/export?");
    expect(csv.getAttribute("href")).toContain("format=csv");
    expect(jsonLink.getAttribute("download")).toBe("audit-log.json");
    expect(jsonLink.getAttribute("href")).toContain("format=json");
    expect(screen.queryByText("Export output")).toBeNull();
  });
});
