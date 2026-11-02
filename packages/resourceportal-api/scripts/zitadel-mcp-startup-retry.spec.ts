import { describe, expect, it, vi } from "vitest";
import { isRetryableMcpReconcileRequest, retryMcpStartupRequest } from "./zitadel-mcp-startup-retry";

describe("MCP OAuth ZITADEL startup retry", () => {
  it("allows replay only for idempotent updates and read-only searches", () => {
    expect(isRetryableMcpReconcileRequest("/admin/v1/policies/label", "PUT")).toBe(true);
    expect(isRetryableMcpReconcileRequest("/management/v1/projects/_search", "POST")).toBe(true);
    expect(isRetryableMcpReconcileRequest("/zitadel.application.v2.ApplicationService/UpdateApplication", "POST")).toBe(true);
    expect(isRetryableMcpReconcileRequest("/v2/organizations", "POST")).toBe(false);
    expect(isRetryableMcpReconcileRequest("/v2/projects", "POST")).toBe(false);
    expect(isRetryableMcpReconcileRequest("/admin/v1/policies/label/_activate", "POST")).toBe(false);
  });
  it("retries transient 503 and 429 before returning success", async () => {
    const send = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const response = await retryMcpStartupRequest(send, { maxElapsedMs: 1000, initialDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it("does not retry permanent authentication errors", async () => {
    const send = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
    expect((await retryMcpStartupRequest(send)).status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("bounds repeating network failures without mutating operations", async () => {
    const send = vi.fn().mockRejectedValue(new TypeError("connection refused"));
    await expect(retryMcpStartupRequest(send, { maxElapsedMs: 1000, initialDelayMs: 1, maxAttempts: 3 }))
      .rejects.toThrow(/retry deadline exceeded/);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
