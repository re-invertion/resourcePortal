import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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


it("shows an error without fabricated TLS findings when diagnostics return HTTP 500", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`${base}/certificate/diagnostics`)) {
      return new Response("Unavailable", { status: 500 });
    }
    if (String(input).endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", tlsEnabled: true,
      dnsStatus: "Valid", certificateStatus: "Error",
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText("Diagnostics unavailable")).toBeTruthy();
  expect(screen.queryByText("No evidence")).toBeNull();
  expect(screen.queryByText("Failure code")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh diagnostics" })).toBeTruthy();
});

it("shows loading status without TLS conclusions while diagnostics are pending", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith(`${base}/certificate/diagnostics`)) {
      return new Promise<Response>(() => {});
    }
    if (String(input).endsWith(base)) return json({
      id: domainId, tenantId, hostname: "app.example.com", tlsEnabled: true,
      dnsStatus: "Valid", certificateStatus: "Error",
    });
    return json([]);
  }));
  render(<TenantDomainDetailPage tenantId={tenantId} domainId={domainId} />);
  expect(await screen.findByText("Loading TLS diagnostics…")).toBeTruthy();
  expect(screen.queryByText("No evidence")).toBeNull();
  expect(screen.queryByText("Failure code")).toBeNull();
});
