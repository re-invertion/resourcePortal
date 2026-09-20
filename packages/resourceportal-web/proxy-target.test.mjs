import { describe, expect, it } from "vitest";
import {
  canonicalForwardedClientIp,
  resolveApiTarget,
  resolveProxyHeaders,
} from "./proxy-target.mjs";

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

describe("production forwarded-header boundary", () => {
  it("uses only the last Traefik-observed XFF address and discards attacker-controlled earlier hops", () => {
    expect(canonicalForwardedClientIp("192.0.2.250, 203.0.113.42")).toBe(
      "203.0.113.42",
    );
    expect(canonicalForwardedClientIp("198.51.100.99, 203.0.113.42")).toBe(
      "203.0.113.42",
    );
  });

  it("fails closed instead of falling back to an earlier spoofed XFF value", () => {
    expect(canonicalForwardedClientIp("192.0.2.250, attacker.invalid")).toBeUndefined();
    expect(canonicalForwardedClientIp("garbage")).toBeUndefined();
  });

  it("rewrites production forwarded headers to one canonical client IP", () => {
    expect(
      resolveProxyHeaders(
        {
          accept: "application/json",
          host: "portal.example.com",
          forwarded: "for=192.0.2.250;proto=http",
          "x-forwarded-for": "192.0.2.250, 203.0.113.42",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-port": "80",
          "x-forwarded-proto": "http",
          "x-dev-user-id": "spoofed-user",
        },
        { NODE_ENV: "production" },
      ),
    ).toMatchObject({
      accept: "application/json",
      host: "portal.example.com",
      "x-forwarded-for": "203.0.113.42",
      "x-forwarded-host": "portal.example.com",
      "x-forwarded-proto": "https",
    });
    const result = resolveProxyHeaders(
      {
        forwarded: "for=192.0.2.250",
        "x-forwarded-for": "192.0.2.250, 203.0.113.42",
        "x-forwarded-port": "80",
        "x-dev-user-id": "spoofed-user",
      },
      { NODE_ENV: "production" },
    );
    expect(result).not.toHaveProperty("forwarded");
    expect(result).not.toHaveProperty("x-forwarded-port");
    expect(result).not.toHaveProperty("x-dev-user-id");
  });

  it("does not forward XFF when Traefik's final value is malformed", () => {
    const result = resolveProxyHeaders(
      { "x-forwarded-for": "192.0.2.250, attacker.invalid" },
      { NODE_ENV: "production" },
    );
    expect(result).not.toHaveProperty("x-forwarded-for");
    expect(result["x-forwarded-proto"]).toBe("https");
  });
});

describe("resolveProxyHeaders development identity", () => {
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
    })).toEqual({
      accept: "application/json",
      "x-forwarded-proto": "https",
    });
  });

  it("does not add a dev identity when it is not configured", () => {
    expect(resolveProxyHeaders({ accept: "application/json" }, {
      NODE_ENV: "development",
    })).toEqual({ accept: "application/json" });
  });
});
