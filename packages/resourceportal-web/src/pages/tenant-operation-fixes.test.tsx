import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantOperationsPage, mayRetryOperation, operationUpdatedAt } from "./tenant-activity-pages";

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
