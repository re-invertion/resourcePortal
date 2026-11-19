import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TenantDomainDetailPage } from "./tenant-storage-pages";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const base = `/api/tenants/${tenantId}/domains/${domainId}`;
function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

it("explains managed-ingress TLS failure separately from DNS and safely queues recovery", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`${base}/certificate/diagnostics`)) return json({
      dnsStatus: "Valid", certificateStatus: "Error", observationStatus: "Failed",
      errorCode: "CertificateObservationFailed", transient: true,
      ingressPublication: "NotVerified", deploymentBlocked: true,
      deploymentBlockReason: "Managed ingress TLS state is Error",
      cause: "Managed ingress TLS inspection failed", canReconcile: true,
      lastCheckedAt: "2026-11-08T14:00:00.000Z",
    });
    if (url.endsWith(`${base}/certificate/reconcile`) && init?.method === "POST") {
      return json({ status: "Pending", id: "op-tls" });
    }
    if (url.endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", type: "Custom",
      tlsEnabled: true, dnsStatus: "Valid", certificateStatus: "Error",
      httpEndpoint: { name: "web", containerPort: 8080 },
    });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByRole("heading", { name: "TLS recovery & diagnostics" })).toBeTruthy();
  expect(await screen.findByText("Managed ingress TLS inspection failed")).toBeTruthy();
  expect(screen.getByText("Why deployment is blocked")).toBeTruthy();
  expect(screen.getByText(/Ingress publication is checked separately/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry TLS reconciliation" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
    String(input).endsWith(`${base}/certificate/reconcile`) && init?.method === "POST",
  )).toBe(true));
  expect(await screen.findByText(/Reconciliation queued/)).toBeTruthy();
});

it("does not offer TLS repair when the API reports insufficient publishability evidence", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`${base}/certificate/diagnostics`)) return json({
      dnsStatus: "Valid", certificateStatus: "Error", observationStatus: "Failed",
      canReconcile: false, transient: false, ingressPublication: "NotVerified",
    });
    if (String(input).endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", tlsEnabled: true,
      dnsStatus: "Valid", certificateStatus: "Error", httpEndpoint: { name: "web" },
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  await screen.findByRole("heading", { name: "TLS recovery & diagnostics" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry TLS reconciliation" }).hasAttribute("disabled")).toBe(true));
});


it("does not fabricate TLS findings when diagnostics API fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`${base}/certificate/diagnostics`)) return new Response("unavailable", { status: 500 });
    if (String(input).endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", tlsEnabled: true,
      dnsStatus: "Valid", certificateStatus: "Error",
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText("Diagnostics unavailable")).toBeTruthy();
  const tlsCard = screen.getByRole("heading", { name: "TLS recovery & diagnostics" }).parentElement!;
  expect(within(tlsCard).queryByText("No evidence")).toBeNull();
  expect(within(tlsCard).queryByText("None")).toBeNull();
  expect(within(tlsCard).queryByText("Not checked")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh diagnostics" })).toBeTruthy();
});

it("shows a loading state without diagnostic conclusions while the API is pending", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`${base}/certificate/diagnostics`)) return new Promise<Response>(() => {});
    if (String(input).endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", tlsEnabled: true,
      dnsStatus: "Valid", certificateStatus: "Error",
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText("Loading TLS diagnostics…")).toBeTruthy();
  const tlsCard = screen.getByRole("heading", { name: "TLS recovery & diagnostics" }).parentElement!;
  expect(within(tlsCard).queryByText("No evidence")).toBeNull();
  expect(within(tlsCard).queryByText("None")).toBeNull();
});

it("refreshes independent DNS evidence after validation and explicit diagnostics refresh", async () => {
  let dnsRequests = 0;
  let dnsCorrected = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`${base}/dns-diagnostics`)) {
      dnsRequests += 1;
      return json({
        status: dnsCorrected ? "Matches" : "Mismatch",
        hostname: "app.example.com",
        expected: { type: "CNAME", target: "apps.resource-portal.local" },
        observed: { cname: dnsCorrected ? ["apps.resource-portal.local"] : ["wrong.example.net"], a: [], aaaa: [] },
      });
    }
    if (url.endsWith(`${base}/validate`) && init?.method === "POST") {
      dnsCorrected = true;
      return json({ dnsStatus: "Valid" });
    }
    if (url.endsWith(`${base}/certificate/diagnostics`)) return json({
      dnsStatus: "Valid", certificateStatus: "Error", canReconcile: false,
    });
    if (url.endsWith(base)) return json({
      id: domainId, tenantId, type: "Custom", hostname: "app.example.com",
      tlsEnabled: true, certificateStatus: "Error", dnsStatus: "Valid",
    });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText("wrong.example.net")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Validate" }));
  expect(await screen.findByText("apps.resource-portal.local")).toBeTruthy();
  await waitFor(() => expect(dnsRequests).toBeGreaterThanOrEqual(2));

  const beforeRefresh = dnsRequests;
  fireEvent.click(screen.getByRole("button", { name: "Refresh diagnostics" }));
  await waitFor(() => expect(dnsRequests).toBeGreaterThan(beforeRefresh));
  expect(fetchMock.mock.calls.some(([input, init]) =>
    String(input).endsWith(`${base}/validate`) && init?.method === "POST",
  )).toBe(true);
});

it("refreshes DNS ownership evidence after confirmed legacy root linking", async () => {
  let linked = false;
  let dnsRequests = 0;
  const rootId = "33333333-3333-4333-8333-333333333333";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`${base}/dns-diagnostics`)) {
      dnsRequests += 1;
      return json({
        status: linked ? "Matches" : "OwnershipUnverified",
        hostname: "app.example.com", expected: { type: "CNAME", target: "apps.resource-portal.local" },
        observed: { cname: linked ? ["apps.resource-portal.local"] : [], a: [], aaaa: [] },
      });
    }
    if (url.endsWith("/domains/custom-root-domains")) return json([
      { id: rootId, rootDomain: "example.com", verificationStatus: "Verified" },
    ]);
    if (url.endsWith(base) && init?.method === "PATCH") {
      const data = JSON.parse(String(init.body)) as { customRootDomainId: string };
      expect(data.customRootDomainId).toBe(rootId);
      linked = true;
      return json({ id: domainId });
    }
    if (url.endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", type: "Custom",
      customRootDomainId: linked ? rootId : null, dnsStatus: "Valid", tlsEnabled: false,
      publication: linked ? { eligible: true } : { eligible: false, reason: "VerifiedRootLinkMissing" },
    });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText(/Not published: verified root link missing/)).toBeTruthy();
  fireEvent.change(await screen.findByRole("combobox", { name: "Verified custom root" }), {
    target: { value: rootId },
  });
  fireEvent.click(screen.getByRole("button", { name: "Link verified root" }));
  const confirmation = screen.getByRole("dialog", { name: "Confirm verified root link" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Link verified root" }));
  await waitFor(() => expect(dnsRequests).toBeGreaterThanOrEqual(2));
  expect(linked).toBe(true);
  expect(fetchMock.mock.calls.some(([input, init]) =>
    String(input).endsWith(base) && init?.method === "PATCH",
  )).toBe(true);
  expect(await screen.findByText("apps.resource-portal.local")).toBeTruthy();
});
