import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppGroupDomainPreflight, domainDeploymentFindings } from "./domain-preflight";

function json(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

const assigned = {
  id: "d1", hostname: "photos.example.test", dnsStatus: "Valid", certificateStatus: "Active",
  httpEndpoint: { id: "endpoint1", appGroupId: "ag1" },
  publication: { eligible: false, reason: "VerifiedRootLinkMissing" },
  ingress: { observedRouter: "NotChecked", preflight: { blockers: ["VerifiedRootLinkMissing"], deploymentRequired: false } },
};

it("filters domain blockers by the assigned App Group, never by hostname or tenant-only membership", () => {
  const result = domainDeploymentFindings([
    assigned,
    { ...assigned, id: "foreign-group", httpEndpoint: { appGroupId: "ag2" } },
    { ...assigned, id: "unassigned", httpEndpoint: null },
  ], "ag1");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: "d1", blockers: ["VerifiedRootLinkMissing"], hostname: "photos.example.test",
  });
});

it("shows actionable DomainOwnershipNotVerified pre-deploy and avoids server-side mutations", async () => {
  const fetchMock = vi.fn(async () => json([assigned]));
  vi.stubGlobal("fetch", fetchMock);
  render(<AppGroupDomainPreflight tenantId="t1" appGroupId="ag1" />);
  expect(await screen.findByText(/DomainOwnershipNotVerified: link this custom hostname/)).toBeTruthy();
  const link = screen.getByRole("link", { name: "photos.example.test" });
  expect(link.getAttribute("href")).toBe("/tenants/t1/domains/d1");
  expect(screen.getByText(/does not verify a live Traefik router/)).toBeTruthy();
  expect(fetchMock.mock.calls.every(([, init]) => !init || !(init as RequestInit).method || (init as RequestInit).method === "GET")).toBe(true);
});

it("treats missing publication diagnostics as unknown, not green readiness", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    { id: "d2", hostname: "legacy.example.test", httpEndpoint: { appGroupId: "ag1" } },
  ])));
  render(<AppGroupDomainPreflight tenantId="t1" appGroupId="ag1" />);
  expect(await screen.findByText(/Publication\/preflight evidence is incomplete/)).toBeTruthy();
  expect(screen.queryByText(/No blockers reported for/)).toBeNull();
});

it("fails closed visually when domain listing is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Access denied", { status: 403 })));
  render(<AppGroupDomainPreflight tenantId="t1" appGroupId="ag1" />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Domain preflight could not be loaded"));
  expect(screen.queryByText(/No blockers reported for/)).toBeNull();
});
