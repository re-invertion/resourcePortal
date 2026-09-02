import { describe, expect, it } from "vitest";
import { resolveApiTarget, resolveProxyHeaders } from "./proxy-target.mjs";

describe("production API proxy target", () => {
  it("preserves the configured API origin for origin-form request targets", () => {
    expect(resolveApiTarget("/api/tenants?limit=10", new URL("http://api.internal:3000"))).toBe(
      "http://api.internal:3000/api/tenants?limit=10",
    );
  });

  it("does not allow an absolute-form request target to replace the configured API origin", () => {
    expect(resolveApiTarget("http://attacker.example/api/secrets?limit=10", new URL("http://api.internal:3000"))).toBe(
      "http://api.internal:3000/api/secrets?limit=10",
    );
  });
});

describe("resolveProxyHeaders", () => {
  it("injects the configured dev user only in non-production mode", () => {
    expect(resolveProxyHeaders({ accept: "application/json", "x-dev-user-id": "spoofed" }, {
      NODE_ENV: "development",
      RESOURCE_PORTAL_DEV_USER_ID: "00000000-0000-4000-8000-000000000001",
    })).toMatchObject({
      accept: "application/json",
      "x-dev-user-id": "00000000-0000-4000-8000-000000000001",
    });

    expect(resolveProxyHeaders({ accept: "application/json" }, {
      NODE_ENV: "production",
      RESOURCE_PORTAL_DEV_USER_ID: "00000000-0000-4000-8000-000000000001",
    })).toEqual({ accept: "application/json" });
  });

  it("does not add a dev identity when it is not configured", () => {
    expect(resolveProxyHeaders({ accept: "application/json" }, {
      NODE_ENV: "development",
    })).toEqual({ accept: "application/json" });
  });
});
