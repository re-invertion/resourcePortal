import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/health") return json({ status: "ok", service: "resource-portal-api", dependencies: { postgres: "ok" } });
    if (url === "/api/tenants") return json([]);
    if (url === "/api/platform/tenants") return json([]);
    if (url === "/api/platform/users") return json([]);
    if (url === "/api/platform/swarm-cluster") return json({ health: "Healthy", nodeCount: 3, managerCount: 1, lastSyncedAt: "2026-09-13T18:00:00.000Z" });
    if (url === "/api/platform/remote-locations") return json([]);
    if (url === "/api/platform/storage-backends") return json([]);
    if (url === "/api/platform/identity-providers") return json([]);
    if (url === "/api/platform/oauth-applications") return json([]);
    if (url === "/api/platform/service-identities") return json([]);
    if (url === "/api/platform/billing/price-lists") return json([]);
    if (url === "/api/platform/billing/vouchers") return json([]);
    if (url === "/api/platform/maintenance") return json({ enabled: false, reason: null });
    if (url === "/api/platform/email") return json({ enabled: false, configured: false, host: null, port: 587, mode: "STARTTLS", username: null, passwordConfigured: false, fromEmail: null, fromName: "ResourcePortal", replyTo: null, lastValidatedAt: null, lastTestSentAt: null, lastError: null });
    if (url === "/api/platform/dns") return json({ provider: "Cloudflare", enabled: false, available: false, configured: false, tokenConfigured: false, zoneId: null, zoneName: null, baseDomain: "resource-portal.pl", targetHostname: "resource-portal.pl", lastValidatedAt: null, lastError: null });
    if (url === "/api/platform/resource-bot") return json({ provider: "OpenAI", enabled: true, available: false, configured: false, apiKeyConfigured: false, generationModel: "gpt-5.6-luna", embeddingModel: "text-embedding-3-small", lastValidatedAt: null, lastError: null });
    if (url === "/api/platform/resource-bot/prices") return json({ items: [] });
    if (url === "/api/platform/network-egress") return json({ enabled: true, revision: 1, protectedCidrs: ["10.0.0.0/8"], updatedAt: null, enforcement: null, appGroups: [], rules: [] });
    return json({ error: { message: `Unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Platform Admin final routes", () => {
  it.each([
    ["overview", "Platform overview"],
    ["tenants", "Tenants"],
    ["users", "Users"],
    ["infrastructure", "Infrastructure"],
    ["identity", "Identity & access"],
    ["billing", "Billing"],
    ["resource-bot", "AI & ResourceBot"],
    ["dns", "DNS & Domains"],
    ["network-egress", "Network Egress"],
    ["security", "Security & operations"],
    ["maintenance", "Maintenance"],
    ["settings", "Settings"],
  ])("renders %s with the final page header", async (section, heading) => {
    installApi();
    render(<PlatformPage section={section} />);
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
  });

  it.each([["identity-providers", "Identity providers"], ["credentials", "Credentials"]])("renders distinct %s final screens", async (section, heading) => {
    installApi();
    render(<PlatformPage section={section} />);
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
  });

  it("routes Billing subpages through the standard tabs", async () => {
    installApi();
    const { rerender } = render(<PlatformPage section="billing" segments={["pricing"]} />);
    expect(await screen.findByRole("heading", { name: "Platform pricing" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pricing" }).getAttribute("aria-current")).toBe("page");

    rerender(<PlatformPage section="billing" segments={["vouchers"]} />);
    expect(await screen.findByRole("heading", { name: "Vouchers" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Vouchers" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps legacy identity and storage deep links on the final UI", async () => {
    installApi();
    const { rerender } = render(<PlatformPage section="identity-providers" />);
    expect(await screen.findByRole("heading", { name: "Identity providers", level: 1 })).toBeTruthy();
    rerender(<PlatformPage section="storage-backends" />);
    expect(await screen.findByRole("heading", { name: "Infrastructure", level: 1 })).toBeTruthy();
  });

  it("does not expose raw JSON editors as the primary Platform Admin UI", async () => {
    installApi();
    render(<PlatformPage section="maintenance" />);
    await screen.findByRole("heading", { name: "Maintenance", level: 1 });
    expect(screen.queryByRole("textbox", { name: /json/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /raw json|json payload|json configuration/i })).toBeNull();
  });
});

it("matches the Penpot Platform overview hierarchy with truthful platform data", async () => {
  installApi();
  render(<PlatformPage section="overview" />);
  expect(await screen.findByRole("heading", { name: "Platform overview", level: 1 })).toBeTruthy();
  for (const label of ["Tenants", "Swarm nodes", "Storage backends", "Identity providers"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(screen.getByRole("heading", { name: "Platform health" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Administration" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Needs attention" })).toBeNull();
});

it("keeps Platform Admin tenant inventory read-only and isolated from tenant workspaces", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/platform/tenants") {
      return json([{
        id: "11111111-1111-4111-8111-111111111111",
        name: "commerce",
        displayName: "Commerce",
        status: "Active",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
      }]);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformPage section="tenants" />);

  expect(await screen.findByText("Commerce")).toBeTruthy();
  expect(screen.getByText("Tenant isolation is enforced")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /open|billing|activity/i })).toBeNull();
  expect(
    [...document.querySelectorAll("a")].some((anchor) =>
      anchor.getAttribute("href")?.startsWith("/tenants/"),
    ),
  ).toBe(false);
});

it("shows the global ResourcePortal user directory in Platform Admin", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/platform/users") {
      return json([{
        id: "22222222-2222-4222-8222-222222222222",
        email: "owner@example.test",
        displayName: "Owner User",
        status: "Active",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
      }]);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformPage section="users" />);

  expect(await screen.findByRole("heading", { name: "Users", level: 1 })).toBeTruthy();
  expect(screen.getByText("Owner User")).toBeTruthy();
  expect(screen.getByText("owner@example.test")).toBeTruthy();
});


it("filters and searches Platform Admin tenant inventory", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/platform/tenants") return json([
      { id: "t1", name: "commerce", displayName: "Commerce", status: "Active", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" },
      { id: "t2", name: "sandbox", displayName: "Sandbox", status: "Suspended", createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" },
    ]);
    return json([]);
  }));
  render(<PlatformPage section="tenants" />);
  expect(await screen.findByText("Commerce")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search tenants"), { target: { value: "sandbox" } });
  expect(screen.queryByText("Commerce")).toBeNull();
  expect(screen.getByText("Sandbox")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search tenants"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Filter tenants by status"), { target: { value: "Suspended" } });
  expect(screen.queryByText("Commerce")).toBeNull();
  expect(screen.getByText("Sandbox")).toBeTruthy();
});

it("filters and searches the Platform Admin user directory", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/platform/users") return json([
      { id: "u1", email: "owner@example.test", displayName: "Owner User", status: "Active", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" },
      { id: "u2", email: "blocked@example.test", displayName: "Blocked User", status: "Suspended", createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" },
    ]);
    return json([]);
  }));
  render(<PlatformPage section="users" />);
  expect(await screen.findByText("Owner User")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "blocked@example.test" } });
  expect(screen.queryByText("Owner User")).toBeNull();
  expect(screen.getByText("Blocked User")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search users"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("Filter users by status"), { target: { value: "Active" } });
  expect(screen.getByText("Owner User")).toBeTruthy();
  expect(screen.queryByText("Blocked User")).toBeNull();
});