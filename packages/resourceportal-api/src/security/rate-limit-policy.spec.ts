import { describe, expect, it } from "vitest";
import { isContainerTerminalRequest, shouldRateLimitRequest } from "./rate-limit-policy";

describe("rate-limit policy", () => {
  it("keeps liveness independent from PostgreSQL-backed rate limiting", () => {
    expect(shouldRateLimitRequest("/api/health/live")).toBe(false);
    expect(shouldRateLimitRequest("/api/health/live?probe=1")).toBe(false);
  });

  it("still limits readiness, auth and tenant API requests", () => {
    expect(shouldRateLimitRequest("/api/health")).toBe(true);
    expect(shouldRateLimitRequest("/api/health/ready")).toBe(true);
    expect(shouldRateLimitRequest("/api/auth/login")).toBe(true);
    expect(shouldRateLimitRequest("/api/tenants" )).toBe(true);
  });
});


describe("tenant terminal request quota classification", () => {
  const terminal = "/api/tenants/11111111-1111-4111-8111-111111111111/app-groups/22222222-2222-4222-8222-222222222222/single-apps/33333333-3333-4333-8333-333333333333/terminal/";
  it("keeps shell I/O rate-limited but separated from unrelated API calls", () => {
    for (const action of ["containers", "start", "read", "write", "resize", "close", "execute"]) {
      expect(isContainerTerminalRequest(terminal + action)).toBe(true);
      expect(shouldRateLimitRequest(terminal + action)).toBe(true);
    }
    expect(isContainerTerminalRequest(terminal + "read?ignore=1")).toBe(true);
    expect(isContainerTerminalRequest("/api/auth/login")).toBe(false);
    expect(isContainerTerminalRequest("/api/health/upgrade")).toBe(false);
    expect(isContainerTerminalRequest("/api/tenants/arbitrary/app-groups/2/single-apps/3/terminal/write")).toBe(false);
    expect(isContainerTerminalRequest(terminal + "privileged")).toBe(false);
  });
});
