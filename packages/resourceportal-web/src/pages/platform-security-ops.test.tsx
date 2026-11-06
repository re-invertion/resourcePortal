import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
const op = {
  id: "f97411d7-0370-4bbf-a974-90f284391e82", tenantId: null,
  type: "SWARM_RECONCILE", status: "Failed", resourceType: "SwarmCluster",
  resourceId: null, phase: "Check", attempt: 1, maxAttempts: 3,
  errorCode: "SwarmUnavailable", errorMessage: "Swarm manager is unavailable",
  createdAt: "2026-11-05T10:00:00.000Z", startedAt: "2026-11-05T10:01:00.000Z",
  completedAt: null,
};
const tenantOp = { ...op, id: "a5a6fd3a-12bf-4f6b-a7e6-8596339829cb", tenantId: "75f128a0-eed2-4f90-b373-23cbb8de05ad", type: "APP_GROUP_DEPLOY" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows only platform-owned operations, details and events, with confirmation before retry", async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url === "/api/platform/operations") return json([op, tenantOp]);
    if (url === "/api/platform/operations/" + op.id) return json(op);
    if (url === "/api/platform/operations/" + op.id + "/events") return json([
      { id: "e1", operationId: op.id, event: "WorkerFailed", message: "Swarm unavailable", timestamp: op.createdAt },
    ]);
    if (url === "/api/platform/operations/" + op.id + "/retry" && method === "POST") return json({});
    return json({}, 404);
  });
  vi.stubGlobal("fetch", mock);
  render(<PlatformPage section="operations" />);
  expect(await screen.findByText("SWARM_RECONCILE")).toBeTruthy();
  expect(screen.queryByText("APP_GROUP_DEPLOY")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View platform operation " + op.id }));
  expect(await screen.findByText("Swarm unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry operation" }));
  expect(requests.some(x => x.method === "POST")).toBe(false);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Retry failed platform operation?" }))
    .getByRole("button", { name: "Request retry" }));
  await waitFor(() => expect(requests.filter(x => x.method === "POST")).toEqual([
    { url: "/api/platform/operations/" + op.id + "/retry", method: "POST" },
  ]));
  expect(requests.some(x => x.url.startsWith("/api/tenants/"))).toBe(false);
});

it("does not expose tenant operation details or allow retries of deployments", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/platform/operations") return json([{ ...op, type: "APP_GROUP_DEPLOY" }]);
    if (url === "/api/platform/operations/" + op.id) return json(tenantOp);
    if (url.endsWith("/events")) return json([]);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<PlatformPage section="operations" />);
  fireEvent.click(await screen.findByRole("button", { name: "View platform operation " + op.id }));
  expect(await screen.findByText(/not a platform-owned operation/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry operation" })).toBeNull();
});

it("filters and exports only platform audit data using server platform endpoint", async () => {
  const requests: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.startsWith("/api/platform/audit-log?")) return json({
      items: [
        { id: "a1", tenantId: null, action: "platform_update", actor: "admin", actorName: "Operator", resourceType: "PlatformConfig", result: "Success", timestamp: op.createdAt },
        { id: "a2", tenantId: tenantOp.tenantId, action: "tenant_secret_update", actor: "other", resourceType: "TenantSecret", result: "Success", timestamp: op.createdAt },
      ],
      nextCursor: null,
    });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<PlatformPage section="audit" />);
  expect(await screen.findByText("platform_update")).toBeTruthy();
  expect(screen.queryByText("tenant_secret_update")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Filter platform audit by action" }), { target: { value: "platform_update" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await waitFor(() => expect(requests.some(x => x.startsWith("/api/platform/audit-log?") && x.includes("action=platform_update"))).toBe(true));
  expect(screen.getByRole("link", { name: "Export platform CSV" }).getAttribute("href"))
    .toContain("/api/platform/audit-log/export?format=csv&action=platform_update");
  expect(requests.some(x => x.startsWith("/api/tenants/"))).toBe(false);
});

it("reflects degraded worker health and never invents healthy status when unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/platform/observability/diagnostics") return json({
      generatedAt: op.createdAt, staleAfterSeconds: 45,
      workers: [{ workerId: "worker-a", status: "Running", healthy: false,
        heartbeatAt: op.createdAt, lastLoopAt: op.startedAt, lastError: "Worker heartbeat stale", lastOperationStatus: "Failed" }],
      reconciliations: [{ workerId: "worker-a", key: "egressPolicy", lastCompletedAt: op.createdAt,
        lastSuccessAt: null, lastFailureAt: op.createdAt, lastDurationMs: 250, lastError: "Enforcement out of sync" }],
    });
    return json({}, 403);
  }));
  const { rerender } = render(<PlatformPage section="worker" />);
  expect(await screen.findByText("Worker health needs attention")).toBeTruthy();
  expect(screen.getByText("Degraded")).toBeTruthy();
  expect(await screen.findByText("Worker heartbeat stale")).toBeTruthy();
  expect(screen.getByText("Enforcement out of sync")).toBeTruthy();
  expect(screen.getByText("egressPolicy")).toBeTruthy();
  expect(screen.getByRole("table", { name: "Worker heartbeats" })).toBeTruthy();
  expect(screen.getByRole("table", { name: "Reconciliation results" })).toBeTruthy();
  rerender(<PlatformPage section="operations" />);
  expect(await screen.findByText("Platform operations unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry operation" })).toBeNull();
});

it("links Network Egress to the real mandatory isolation dashboard", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({
    enabled: true, revision: 1, protectedCidrs: ["10.0.0.0/8"], updatedAt: null,
    enforcement: { lastSuccessAt: null, lastFailureAt: null, lastError: null },
  })));
  render(<PlatformPage section="network-egress" />);
  expect(await screen.findByRole("heading", { name: "Network Egress", level: 1 })).toBeTruthy();
  expect(screen.getByText("Mandatory protection")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Disable network egress" })).toBeNull();
});

it("fails closed if a subsequent platform operations refresh is denied", async () => {
  let deny = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/platform/operations") return deny ? json({}, 403) : json([op]);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<PlatformPage section="operations" />);
  expect(await screen.findByText("SWARM_RECONCILE")).toBeTruthy();
  deny = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Platform operations unavailable")).toBeTruthy();
  expect(screen.queryByText("SWARM_RECONCILE")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry operation" })).toBeNull();
});

it("refuses event data with a different operation identifier", async () => {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/platform/operations") return json([op]);
    if (url === "/api/platform/operations/" + op.id) return json(op);
    if (url === "/api/platform/operations/" + op.id + "/events") return json([
      { id: "wrong", operationId: tenantOp.id, event: "Unrelated", message: "Cross-resource data", timestamp: op.createdAt },
    ]);
    return json({}, 404);
  });
  vi.stubGlobal("fetch", mock);
  render(<PlatformPage section="operations" />);
  fireEvent.click(await screen.findByRole("button", { name: "View platform operation " + op.id }));
  expect(await screen.findByText("No operation events recorded.")).toBeTruthy();
  expect(screen.queryByText("Cross-resource data")).toBeNull();
});
