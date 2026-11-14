import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { MCP_LOOPBACK_HEADER, McpLoopbackDelegationService } from "./mcp-loopback-delegation.service";

const tenant = "22222222-2222-4222-8222-222222222222";
const other = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const accessToken = "rpoat_v1_opaque";
const target = `/api/tenants/${tenant}/app-groups?limit=2`;

function issue(service: McpLoopbackDelegationService, path = target) {
  return service.issue({
    userId, tenantId: tenant, method: "GET", target: path,
    resourceAccessToken: accessToken,
  });
}
function req(proof: string, path = target, method = "GET", address = "127.0.0.1") {
  return {
    method, url: path,
    headers: { [MCP_LOOPBACK_HEADER]: proof },
    raw: { socket: { remoteAddress: address } },
  } as unknown as FastifyRequest;
}

describe("MCP one-time same-process loopback delegation", () => {
  it("authenticates exact user, tenant, method and query once", () => {
    const service = new McpLoopbackDelegationService();
    const proof = issue(service);
    expect(service.consume(req(proof))).toEqual({
      userId, tenantId: tenant, accessToken,
    });
    expect(() => service.consume(req(proof))).toThrow("Invalid MCP loopback delegation");
  });

  it.each([
    ["wrong method", target, "POST"],
    ["different endpoint", `/api/tenants/${tenant}/volumes`, "GET"],
    ["different tenant", `/api/tenants/${other}/app-groups?limit=2`, "GET"],
    ["different query", `/api/tenants/${tenant}/app-groups?limit=100`, "GET"],
  ])("rejects %s and consumes the proof", (_case, path, method) => {
    const service = new McpLoopbackDelegationService();
    const proof = issue(service);
    expect(() => service.consume(req(proof, path, method))).toThrow("Invalid MCP loopback delegation");
    expect(() => service.consume(req(proof))).toThrow("Invalid MCP loopback delegation");
  });

  it.each(["192.168.1.1", "198.51.100.1", null])("rejects non-loopback addresses (%s)", (addr) => {
    const service = new McpLoopbackDelegationService();
    expect(() => service.consume(req(issue(service), target, "GET", addr as string)))
      .toThrow("Invalid MCP loopback delegation");
  });

  it("rejects forged, missing and cross-instance proofs", () => {
    const service = new McpLoopbackDelegationService();
    const proof = issue(service);
    expect(() => service.consume(req(proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A")))).toThrow("Invalid MCP loopback delegation");
    expect(() => new McpLoopbackDelegationService().consume(req(proof))).toThrow("Invalid MCP loopback delegation");
    expect(() => service.consume(req(""))).toThrow("Invalid MCP loopback delegation");
    // Invalid signature does not consume the legitimate pending proof.
    expect(service.consume(req(proof)).userId).toBe(userId);
  });

  it("expires even an unused signed proof", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-14T10:00:00Z"));
      const service = new McpLoopbackDelegationService();
      const proof = issue(service);
      vi.advanceTimersByTime(16_000);
      expect(() => service.consume(req(proof))).toThrow("Invalid MCP loopback delegation");
    } finally { vi.useRealTimers(); }
  });

  it("never delegates unrelated REST paths, a different tenant, or legacy JWT", () => {
    const service = new McpLoopbackDelegationService();
    for (const path of [
      "/api/users", "/api/auth/login", "/api/tenants/" + other + "/app-groups",
      "/api/tenants/" + tenant + "/mcp", "/api/tenants/" + tenant + "/mcp/tools",
      "/api/tenants/" + tenant + "/../platform/users",
      "/api/platform/mcp",
      "https://evil.example/api/tenants/" + tenant + "/app-groups",
    ]) {
      expect(() => issue(service, path)).toThrow("Invalid MCP loopback delegation");
    }
    expect(() => service.issue({
      userId, tenantId: tenant, method: "GET", target,
      resourceAccessToken: "zitadel.jwt.credential",
    })).toThrow("Invalid MCP loopback delegation");
  });

  it("allows tenant-root read for manage_access:get_tenant", () => {
    const service = new McpLoopbackDelegationService();
    const path = `/api/tenants/${tenant}`;
    expect(service.consume(req(issue(service, path), path))).toMatchObject({
      userId, tenantId: tenant,
    });
  });

  it("allows platform read delegation only as an internal proof; final admin RBAC stays mandatory", () => {
    const service = new McpLoopbackDelegationService();
    const path = "/api/platform/bug-reports";
    expect(service.consume(req(issue(service, path), path))).toMatchObject({ userId, tenantId: tenant });
  });
});
