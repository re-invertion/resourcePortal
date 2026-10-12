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
