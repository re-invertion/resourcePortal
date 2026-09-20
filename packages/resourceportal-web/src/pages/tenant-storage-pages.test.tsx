import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TenantDomainsPage, TenantRegistriesPage, TenantVolumesPage } from "./tenant-storage-pages";

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/tenants/t1/quota")) return Promise.resolve(json({ storageBytes: "4294967296" }));
    if (url.includes("/api/tenants/t1/volumes")) return Promise.resolve(json([
      { id: "v1", name: "data-prod", sizeBytes: "1073741824", usedSizeBytes: "536870912", status: "Ready", attachmentCount: 2, updatedAt: "2026-09-14T08:00:00.000Z" },
      { id: "v2", name: "legacy-data", sizeBytes: "536870912", usedSizeBytes: "268435456", status: "Error", attachmentCount: 0, updatedAt: "2026-09-13T08:00:00.000Z" },
    ]));
    return Promise.resolve(json({}));
  }));
});

it("matches the final Penpot Volumes information hierarchy", async () => {
  render(<TenantVolumesPage tenantId="t1" />);

  expect(await screen.findByText("Persistent volumes")).toBeTruthy();
  expect(screen.getByText("Allocated")).toBeTruthy();
  expect(screen.getByText("Attached")).toBeTruthy();
  expect(screen.getByText("Needs attention")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Search volumes" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Filter by status" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Attachments" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Used" })).toBeTruthy();
  expect(screen.getAllByText("Ready").length).toBeGreaterThan(1);
  expect(screen.getAllByText("Error").length).toBeGreaterThan(1);
});

it("matches the final Penpot Registries information hierarchy using API-backed fields", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/tenants/t1/registries")) return Promise.resolve(json([
      { id: "r1", name: "Default GHCR", host: "ghcr.io", tlsMode: "TLS", authType: "Token", hasCredential: true, validationStatus: "Valid", updatedAt: "2026-09-14T08:00:00.000Z" },
      { id: "r2", name: "Docker Hub", host: "registry-1.docker.io", tlsMode: "TLS", authType: "UsernamePassword", hasCredential: true, validationStatus: "Valid", updatedAt: "2026-09-13T08:00:00.000Z" },
      { id: "r3", name: "Internal", host: "registry.internal", tlsMode: "NoTLS", authType: "None", hasCredential: false, validationStatus: "Invalid", updatedAt: "2026-09-12T08:00:00.000Z" },
    ]));
    return Promise.resolve(json({}));
  }));

  render(<TenantRegistriesPage tenantId="t1" />);

  expect(await screen.findByText("Container registries")).toBeTruthy();
  const summary = screen.getByRole("region", { name: "Registry summary" });
  expect(within(summary).getByText("Validated")).toBeTruthy();
  expect(within(summary).getByText("Credentials")).toBeTruthy();
  expect(within(summary).getByText("Issues")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Name" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Auth" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
  expect(screen.getByText("User/pass")).toBeTruthy();
  expect(screen.getByText("Image pull behavior")).toBeTruthy();
  expect(screen.getByText(/credentials are write-only/i)).toBeTruthy();
});


it("matches the final Penpot Domains hierarchy without exposing assignment UUIDs", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tenants/t1/domains")) return Promise.resolve(json([
      { id: "d1", hostname: "api.resource-portal.pl", type: "Managed", dnsStatus: "Valid", tlsEnabled: true, certificateStatus: "Active", updatedAt: "2026-09-14T08:00:00.000Z", httpEndpoint: { id: "ep1", name: "api", singleAppId: "app1", singleAppName: "api", appGroupId: "ag1" } },
      { id: "d2", hostname: "portal.example.com", type: "Custom", dnsStatus: "Pending", tlsEnabled: false, certificateStatus: "Pending", updatedAt: "2026-09-13T08:00:00.000Z", httpEndpoint: { id: "ep2", name: "web", singleAppId: "app2", singleAppName: "web", appGroupId: "ag2" } },
      { id: "d3", hostname: "unused.example.com", type: "Custom", dnsStatus: "Valid", tlsEnabled: false, certificateStatus: "Pending", updatedAt: "2026-09-12T08:00:00.000Z", httpEndpoint: null },
    ]));
    if (url.endsWith("/api/tenants/t1/domains/custom-root-domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/app-groups")) return Promise.resolve(json([
      { id: "ag1", name: "commerce-prod" },
      { id: "ag2", name: "customer-portal" },
    ]));
    return Promise.resolve(json({}));
  }));

  render(<TenantDomainsPage tenantId="t1" />);

  expect(await screen.findByText("Domains & routing")).toBeTruthy();
  const summary = screen.getByRole("region", { name: "Domain summary" });
  expect(within(summary).getByText("Validated")).toBeTruthy();
  expect(within(summary).getByText("TLS")).toBeTruthy();
  expect(within(summary).getByText("Assignments")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Hostname" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Validation" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Assigned to" })).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: "Updated" })).toBeTruthy();
  expect(screen.getByText("commerce-prod / api")).toBeTruthy();
  expect(screen.queryByText("ag1")).toBeNull();
});


it("confirms in-app before deleting a tenant volume", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/tenants/t1/quota")) return Promise.resolve(json({ storageBytes: "4294967296" }));
    if (url.includes("/api/tenants/t1/volumes")) return Promise.resolve(json([{ id: "v2", name: "legacy-data", sizeBytes: "536870912", usedSizeBytes: "268435456", status: "Ready", attachmentCount: 0 }]));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);
  const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

  render(<TenantVolumesPage tenantId="t1" />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete legacy-data" }));
  expect(screen.getByRole("dialog", { name: "Delete volume legacy-data?" })).toBeTruthy();
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Delete volume" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/api/tenants/t1/volumes/v2") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
});

it("confirms in-app before deleting a tenant registry", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tenants/t1/registries") && (!init?.method || init.method === "GET")) return Promise.resolve(json([
      { id: "r1", name: "Internal", host: "registry.internal", tlsMode: "TLS", authType: "None", validationStatus: "Valid" },
    ]));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantRegistriesPage tenantId="t1" />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete Internal" }));
  expect(screen.getByRole("dialog", { name: "Delete registry Internal?" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Delete registry" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/api/tenants/t1/registries/r1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
});

it("confirms in-app before deleting a tenant domain", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/tenants/t1/domains") && (!init?.method || init.method === "GET")) return Promise.resolve(json([
      { id: "d1", hostname: "app.example.com", type: "Custom", dnsStatus: "Valid", tlsEnabled: true, certificateStatus: "Active", httpEndpoint: null },
    ]));
    if (url.endsWith("/api/tenants/t1/domains/custom-root-domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/app-groups")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<TenantDomainsPage tenantId="t1" />);

  fireEvent.click(await screen.findByRole("button", { name: "Delete app.example.com" }));
  expect(screen.getByRole("dialog", { name: "Delete domain app.example.com?" })).toBeTruthy();
  expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Delete domain" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/api/tenants/t1/domains/d1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
});

it("hides Managed ResourcePortal domains until Platform Admin enables Cloudflare DNS", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tenants/t1/domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/domains/capabilities")) return Promise.resolve(json({ managedDomains: { enabled: false, provider: "Cloudflare", baseDomain: "resource-portal.pl" } }));
    if (url.endsWith("/api/tenants/t1/domains/custom-root-domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/app-groups")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  }));

  render(<TenantDomainsPage tenantId="t1" />);
  expect(await screen.findByText(/managed ResourcePortal domains are disabled/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  const type = screen.getByLabelText("Domain type");
  expect(within(type).queryByRole("option", { name: "Managed ResourcePortal domain" })).toBeNull();
  expect(within(type).getByRole("option", { name: "Custom domain" })).toBeTruthy();
});

it("offers Managed ResourcePortal domains only after the platform Cloudflare capability is enabled", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/tenants/t1/domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/domains/capabilities")) return Promise.resolve(json({ managedDomains: { enabled: true, provider: "Cloudflare", baseDomain: "resource-portal.pl" } }));
    if (url.endsWith("/api/tenants/t1/domains/custom-root-domains")) return Promise.resolve(json([]));
    if (url.endsWith("/api/tenants/t1/app-groups")) return Promise.resolve(json([]));
    return Promise.resolve(json({}));
  }));

  render(<TenantDomainsPage tenantId="t1" />);
  await screen.findByText("Domains & routing");
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  const type = screen.getByLabelText("Domain type");
  expect(within(type).getByRole("option", { name: "Managed ResourcePortal domain" })).toBeTruthy();
  expect(screen.getByText(/Creates app\.resource-portal\.pl/i)).toBeTruthy();
});
