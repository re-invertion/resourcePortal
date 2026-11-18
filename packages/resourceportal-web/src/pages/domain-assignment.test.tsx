import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantDomainDetailPage } from "./tenant-storage-pages";

function json(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } }); }
afterEach(() => vi.unstubAllGlobals());

it("discovers app and endpoint from an unassigned domain and requires confirmation before PATCH", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) {
      return json({ id: "d1", hostname: "demo.example.test", type: "Managed", dnsStatus: "Valid", tlsEnabled: true, httpEndpoint: null });
    }
    if (path.endsWith("/app-groups")) return json([{ id: "g1", name: "production" }]);
    if (path.endsWith("/app-groups/g1/single-apps")) return json([{ id: "a1", name: "frontend" }]);
    if (path.endsWith("/app-groups/g1/single-apps/a1/http-endpoints")) return json([{ id: "e1", name: "http", containerPort: 8080 }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", { name: "Assign to an application" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Assign App Group" }), { target: { value: "g1" } });
  fireEvent.change(await screen.findByRole("combobox", { name: "Assign application" }), { target: { value: "a1" } });
  await screen.findByRole("option", { name: /http.*port 8080/ });
  fireEvent.change(screen.getByRole("combobox", { name: "Assign HTTP endpoint" }), { target: { value: "e1" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign to endpoint" }));
  expect(screen.getByRole("dialog", { name: "Confirm domain assignment" })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([_, options]) => (options as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Assign domain" }));
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith("/domains/d1") && (opts as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit | undefined)?.body))).toEqual({ httpEndpointId: "e1" });
  });
});

it("#394 links a legacy custom hostname only to an explicitly selected verified root, preserving other domain settings", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/domains/d1")) return json({
      id: "d1", tenantId: "t1", type: "Custom", hostname: "photos.example.com",
      customRootDomainId: null, dnsStatus: "Valid", certificateStatus: "Active",
      publication: { eligible: false, reason: "VerifiedRootLinkMissing" },
      tlsEnabled: true, httpEndpoint: { id: "e1", name: "web", containerPort: 8080 },
    });
    if (path.endsWith("/domains/custom-root-domains")) return json([
      { id: "root-v", rootDomain: "example.com", verificationStatus: "Verified" },
      { id: "root-pending", rootDomain: "pending.example.com", verificationStatus: "Pending" },
      { id: "root-other", rootDomain: "unrelated.net", verificationStatus: "Verified" },
    ]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId="t1" domainId="d1" />);
  expect(await screen.findByRole("heading", { name: "Link verified custom root" })).toBeTruthy();
  expect(screen.getByText(/verified root link missing/i)).toBeTruthy();
  const choice = screen.getByRole("combobox", { name: "Verified custom root" });
  expect(choice.querySelectorAll("option")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Link verified root" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(choice, { target: { value: "root-v" } });
  fireEvent.click(screen.getByRole("button", { name: "Link verified root" }));
  expect(screen.getByRole("dialog", { name: "Confirm verified root link" })).toBeTruthy();
  expect(fetchMock.mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === "PATCH")).toHaveLength(0);
  const dialog = screen.getByRole("dialog", { name: "Confirm verified root link" });
  const confirm = Array.from(dialog.querySelectorAll("button")).find(b => b.textContent?.trim() === "Link verified root");
  expect(confirm).toBeTruthy();
  fireEvent.click(confirm!);
  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(([url, opts]) => String(url).endsWith("/domains/d1") && (opts as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse(String((patch?.[1] as RequestInit | undefined)?.body))).toEqual({ customRootDomainId: "root-v" });
  });
});
