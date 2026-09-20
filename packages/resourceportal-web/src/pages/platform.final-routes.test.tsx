import { cleanup, render, screen } from "@testing-library/react";
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
    if (url === "/api/platform/swarm-cluster") return json({ health: "Healthy", nodeCount: 3, managerCount: 1, lastSyncedAt: "2026-09-13T18:00:00.000Z" });
    if (url === "/api/platform/remote-locations") return json([]);
    if (url === "/api/platform/storage-backends") return json([]);
    if (url === "/api/platform/identity-providers") return json([]);
    if (url === "/api/platform/oauth-applications") return json([]);
    if (url === "/api/platform/service-identities") return json([]);
    if (url === "/api/platform/billing/price-lists") return json([]);
    if (url === "/api/platform/billing/vouchers") return json([]);
    if (url === "/api/platform/maintenance") return json({ enabled: false, reason: null });
    if (url === "/api/platform/dns") return json({ provider: "Cloudflare", enabled: false, available: false, configured: false, tokenConfigured: false, zoneId: null, zoneName: null, baseDomain: "resource-portal.pl", targetHostname: "resource-portal.pl", lastValidatedAt: null, lastError: null });
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
    ["infrastructure", "Infrastructure"],
    ["identity", "Identity & access"],
    ["billing", "Billing"],
    ["dns", "DNS & Domains"],
    ["security", "Security & operations"],
    ["maintenance", "Maintenance"],
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
