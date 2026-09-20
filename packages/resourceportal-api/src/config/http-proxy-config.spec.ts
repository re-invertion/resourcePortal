import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { apiTrustProxy } from "./http-proxy-config";

describe("apiTrustProxy", () => {
  it("does not trust forwarded headers outside production", () => {
    expect(apiTrustProxy("development", undefined)).toBe(false);
    expect(apiTrustProxy("test", "5")).toBe(false);
  });

  it("trusts exactly one proxy hop by default in production", () => {
    expect(apiTrustProxy("production", undefined)).toBe("uniquelocal");
  });

  it("accepts exactly one production proxy hop and rejects broader trust", () => {
    expect(apiTrustProxy(" Production ", "1")).toBe("uniquelocal");
    expect(() => apiTrustProxy("production", "0")).toThrow(
      "API_TRUST_PROXY_HOPS must be a positive integer",
    );
    expect(() => apiTrustProxy("production", "2")).toThrow(
      "API_TRUST_PROXY_HOPS must be exactly 1 in production",
    );
  });

  it("uses the forwarded client IP only when one proxy hop is trusted", async () => {
    const trusted = Fastify({ trustProxy: apiTrustProxy("production", "1") });
    trusted.get("/", (request) => ({ ip: request.ip }));
    const trustedResponse = await trusted.inject({
      method: "GET",
      url: "/",
      remoteAddress: "10.10.0.8",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    expect(trustedResponse.json()).toEqual({ ip: "203.0.113.42" });
    await trusted.close();

    const untrusted = Fastify({ trustProxy: false });
    untrusted.get("/", (request) => ({ ip: request.ip }));
    const untrustedResponse = await untrusted.inject({
      method: "GET",
      url: "/",
      remoteAddress: "10.10.0.8",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    expect(untrustedResponse.json()).toEqual({ ip: "10.10.0.8" });
    await untrusted.close();
  });
  it("ignores forwarded headers from an untrusted public peer", async () => {
    const app = Fastify({ trustProxy: apiTrustProxy("production", "1") });
    app.get("/", (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "198.51.100.8",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    expect(response.json()).toEqual({ ip: "198.51.100.8" });
    await app.close();
  });

  it("uses the nearest forwarded address and ignores earlier spoofed chain entries", async () => {
    const app = Fastify({ trustProxy: apiTrustProxy("production", "1") });
    app.get("/", (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/",
      remoteAddress: "10.10.0.8",
      headers: {
        "x-forwarded-for": "192.0.2.250, 203.0.113.42",
      },
    });
    expect(response.json()).toEqual({ ip: "203.0.113.42" });
    await app.close();
  });

});
