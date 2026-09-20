import { describe, expect, it } from "vitest";
import { shouldRateLimitRequest } from "./rate-limit-policy";

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
