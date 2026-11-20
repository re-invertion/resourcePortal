import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantOperationsPage, mayRetryOperation, operationUpdatedAt, operationWithinTimeRange } from "./tenant-activity-pages";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

it("never retries successful or deployment mirror operations", () => {
  expect(mayRetryOperation({ type: "APP_GROUP_DEPLOY", status: "Failed" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Succeeded" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Pending" })).toBe(false);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "Failed" })).toBe(true);
  expect(mayRetryOperation({ type: "MAINTENANCE", status: "RollbackFailed" })).toBe(true);
});

it("shows the same best known operation update timestamp on list and detail", () => {
  expect(operationUpdatedAt({ createdAt: "a", startedAt: "b", completedAt: "c" })).toBe("c");
  expect(operationUpdatedAt({ createdAt: "a", startedAt: "b" })).toBe("b");
  expect(operationUpdatedAt({ createdAt: "a" })).toBe("a");
});

it("hides retry for a successful operation", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    json(String(input).endsWith("/events") ? [] : {
      id: "op1", type: "VOLUME_CREATE", status: "Succeeded", createdAt: "2026-10-10T10:00:00Z", completedAt: "2026-10-10T10:01:00Z",
    })
  ));
  render(<TenantOperationsPage tenantId="t1" operationId="op1" />);
  expect(await screen.findByText("Succeeded")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry operation" })).toBeNull();
});

it("shows the recorded failure reason and a retry action for retryable operations", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
    json(String(input).endsWith("/events") ? [] : {
      id: "op2", type: "VOLUME_CREATE", status: "Failed", errorCode: "BackendUnavailable",
      errorMessage: "Volume service is not reachable", createdAt: "2026-10-10T10:00:00Z", completedAt: "2026-10-10T10:01:00Z",
    })
  ));
  render(<TenantOperationsPage tenantId="t1" operationId="op2" />);
  expect(await screen.findByText(/Volume service is not reachable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry operation" })).toBeTruthy();
});

it("#399 filters tenant operations by resource name and actor without issuing write requests", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "op1", type: "VOLUME_CREATE", status: "Succeeded", resourceName: "backup-photos", createdByDisplayName: "Alice Operator", createdAt: "2026-10-10T10:01:00Z" },
    { id: "op2", type: "VOLUME_CREATE", status: "Failed", resourceName: "database", createdByDisplayName: "Bob Operator", createdAt: "2026-10-10T10:02:00Z" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("backup-photos")).toBeTruthy();
  const search = screen.getByRole("textbox", { name: "Search operations" });
  fireEvent.change(search, { target: { value: "backup-photos" } });
  expect(screen.getByText("backup-photos")).toBeTruthy();
  expect(screen.queryByText("database")).toBeNull();
  fireEvent.change(search, { target: { value: "Bob Operator" } });
  expect(screen.getByText("database")).toBeTruthy();
  expect(screen.queryByText("backup-photos")).toBeNull();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("#399 shows a friendly operation resource name with its technical type as secondary context", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "op1", type: "APP_GROUP_DEPLOY", status: "Pending", resourceName: "photos service", resourceType: "AppGroupDeployment", createdAt: "2026-10-10T10:01:00Z" },
    { id: "op2", type: "VOLUME_CREATE", status: "Succeeded", resourceType: "Volume", createdAt: "2026-10-10T10:02:00Z" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("photos service")).toBeTruthy();
  expect(screen.getByText("AppGroupDeployment")).toBeTruthy();
  expect(screen.getByText("Volume")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Operation status" }), { target: { value: "Pending" } });
  expect(screen.getByText("photos service")).toBeTruthy();
  expect(screen.queryByText("Volume")).toBeNull();
  expect(fetchMock.mock.calls.every(([input]) => String(input).includes("/api/tenants/t1/operations"))).toBe(true);
});

it("#399 updated-time filter includes bounds and excludes undated operations only when active", () => {
  const before = { updatedAt: "2026-10-10T08:00:00Z" };
  const inRange = { updatedAt: "2026-10-10T10:00:00Z" };
  const after = { updatedAt: "2026-10-10T12:00:00Z" };
  const from = "2026-10-10T09:00:00Z", to = "2026-10-10T11:00:00Z";
  expect(operationWithinTimeRange(before, from, to)).toBe(false);
  expect(operationWithinTimeRange(inRange, from, to)).toBe(true);
  expect(operationWithinTimeRange(after, from, to)).toBe(false);
  expect(operationWithinTimeRange({ createdAt: "2026-10-10T10:00:00Z" }, from, to)).toBe(true);
  expect(operationWithinTimeRange({}, "", "")).toBe(true);
  expect(operationWithinTimeRange({}, from, "")).toBe(false);
});

it("#399 filters tenant Operations by entered update range without extra API requests", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([
    { id: "old", resourceName: "old backup", status: "Succeeded", updatedAt: "2026-10-10T07:00:00Z" },
    { id: "recent", resourceName: "recent backup", status: "Pending", updatedAt: "2026-10-10T12:00:00Z" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantOperationsPage tenantId="t1" />);
  expect(await screen.findByText("old backup")).toBeTruthy();
  expect(screen.getByText("recent backup")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Operations updated from"), { target: { value: "2026-10-10T09:00" } });
  expect(screen.queryByText("old backup")).toBeNull();
  expect(screen.getByText("recent backup")).toBeTruthy();
  expect(fetchMock.mock.calls.every(([input, init]) => String(input).includes("/api/tenants/t1/operations") && (!init?.method || init.method === "GET"))).toBe(true);
});
