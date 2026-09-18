import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("platform action feedback", () => {
  it("reports reconcile completion without dumping the mutation response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/swarm-cluster" && (init?.method ?? "GET") === "GET") return json({ status: "Ready" });
      if (url === "/api/platform/swarm-cluster/reconcile") return json({ reconciled: true, nodeCount: 3 });
      if (url === "/api/platform/remote-locations") return json([]);
      if (url === "/api/platform/storage-backends") return json([]);
      return json({ error: { message: `Unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="infrastructure" />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reconcile Swarm cluster" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Reconcile Swarm cluster completed"));
    expect(screen.queryByText("Reconciled")).toBeNull();
    expect(screen.queryByText("Node count")).toBeNull();
  });

  it("offers only API-backed reconcile actions on Platform Infrastructure", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/platform/swarm-cluster") return json({ status: "Ready" });
      if (url === "/api/platform/remote-locations") return json([{ id: "11111111-1111-4111-8111-111111111111", displayName: "Edge EU", status: "Ready", type: "Remote" }]);
      if (url === "/api/platform/storage-backends") return json([{ id: "22222222-2222-4222-8222-222222222222", name: "Primary storage", type: "NFS", health: "Healthy" }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="infrastructure" />);
    await screen.findByText("Primary storage");

    expect(screen.getByRole("button", { name: "Reconcile Swarm cluster" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /reconcile/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Validate" })).toBeTruthy();
  });

  it("reports settings saves without rendering a second copy of the response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/maintenance" && (init?.method ?? "GET") === "GET") return json({ enabled: false, reason: "" });
      if (url === "/api/platform/maintenance" && init?.method === "PATCH") return json({ enabled: true, reason: "planned" });
      return json({ error: { message: `Unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="maintenance" />);
    await screen.findByText("Maintenance state");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("dialog", { name: /confirm maintenance change/i })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /confirm maintenance change/i }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Maintenance state saved"));
  });
  it("uses the tenant audit-log endpoint for Platform Security diagnostics", async () => {
    const tenantId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/tenants") return json([{ id: tenantId, name: "Commerce" }]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="security" />);
    await screen.findByRole("heading", { name: "Security & operations", level: 1 });
    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: tenantId } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/tenants/${tenantId}/operations`)).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/tenants/${tenantId}/audit-log?limit=50`)).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`/${tenantId}/audit?`))).toBe(false);
  });

  it("uses the real tenant billing and usage endpoints in Platform Billing", async () => {
    const tenantId = "44444444-4444-4444-8444-444444444444";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/tenants") return json([{ id: tenantId, name: "Commerce" }]);
      if (url === "/api/platform/billing/price-lists") return json([]);
      if (url === "/api/platform/billing/vouchers") return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="billing" />);
    await screen.findByRole("heading", { name: "Billing", level: 1 });
    fireEvent.change(screen.getByLabelText("Tenant"), { target: { value: tenantId } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/tenants/${tenantId}/billing`)).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/tenants/${tenantId}/quota`)).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/tenants/${tenantId}/billing/usage-records?limit=20`)).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/billing/quota"))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/billing/usage?"))).toBe(false);
  });

  it("shows only API-backed platform identity-provider actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/platform/identity-providers") return json([{ id: "33333333-3333-4333-8333-333333333333", name: "Corporate SSO", protocol: "OIDC", issuer: "https://login.example.com", enabled: true }]);
      if (url === "/api/platform/oauth-applications") return json([]);
      if (url === "/api/platform/service-identities") return json([]);
      return json([]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="identity" />);
    await screen.findByText("Corporate SSO");

    expect(screen.queryByRole("button", { name: "Validate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("creates an OIDC platform identity provider from typed fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/identity-providers" && (init?.method ?? "GET") === "GET") return json([]);
      if (url === "/api/platform/oauth-applications") return json([]);
      if (url === "/api/platform/service-identities") return json([]);
      if (url === "/api/platform/identity-providers" && init?.method === "POST") return json({ id: "idp-1", name: "Corporate SSO", protocol: "OIDC", enabled: true }, 201);
      return json({ error: { message: `Unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="identity" />);
    await screen.findByRole("heading", { name: "Identity & access", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Add identity provider" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Corporate SSO" } });
    fireEvent.change(screen.getByLabelText("Issuer URL"), { target: { value: "https://login.example.com" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "resource-portal" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Create identity provider" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/platform/identity-providers" && init?.method === "POST")).toBe(true));
    const call = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/platform/identity-providers" && init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ name: "Corporate SSO", protocol: "OIDC", issuer: "https://login.example.com", clientId: "resource-portal", clientSecret: "secret" });
  });

});
