import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcIssuerTransport } from "./oidc-issuer-transport";
import { OidcAuthService } from "./oidc-auth.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";

const issuer = "https://auth.example.test";

afterEach(() => vi.unstubAllGlobals());

describe("P0 #437 private OIDC issuer transport", () => {
  it("collapses concurrent public readiness requests without caching a stale healthy result", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/.well-known/openid-configuration")) {
        await pending;
        return new Response(JSON.stringify({
          issuer,
          jwks_uri: issuer + "/oauth/v2/keys",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ keys: [{ kid: "example-key" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg = { get: (key: string) => key === "OIDC_ISSUER_URL" ? issuer : undefined } as ConfigService;
    const auth = new OidcAuthService(cfg, {} as PrismaService);
    const all = Array.from({ length: 12 }, () => auth.probeIssuerConnectivity());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all(all)).resolves.toHaveLength(12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await auth.probeIssuerConnectivity();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves public HTTPS authority and requires the private Traefik dispatcher", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    const transport = new OidcIssuerTransport(issuer, "traefik");
    await transport.fetch(issuer + "/.well-known/openid-configuration", "discovery");
    const url = String(mockFetch.mock.calls[0]?.[0]);
    const options = mockFetch.mock.calls[0]?.[1] as (RequestInit & { dispatcher?: unknown });
    expect(url).toBe(issuer + "/.well-known/openid-configuration");
    expect(options.redirect).toBe("manual");
    expect(options.dispatcher).toBeDefined();
    expect(options.dispatcher).toHaveProperty("dispatch");
    expect(String(url)).not.toContain("http://zitadel:8080");
  });

  it("does not use private routing for unauthorised hosts or issuer port mismatches", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const transport = new OidcIssuerTransport(issuer, "traefik");
    for (const url of [
      "https://malicious.example.test/oauth/v2/token",
      "https://auth.example.test:8443/oauth/v2/keys",
      "https://user:password@auth.example.test/oauth/v2/keys",
    ]) {
      await expect(transport.fetch(url, "jwks")).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not disable TLS verification or follow a redirect to another host", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", {
      status: 302, headers: { location: "https://attacker.example.test/" },
    }));
    vi.stubGlobal("fetch", mockFetch);
    const transport = new OidcIssuerTransport(issuer, "traefik");
    await expect(transport.fetch(issuer + "/oauth/v2/token", "code-exchange", {
      method: "POST",
      body: "code=secret",
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "manual", method: "POST" });
    expect(JSON.stringify(mockFetch.mock.calls[0][1])).not.toContain("rejectUnauthorized");
  });

  it("turns public WAN refusal into sanitized 503 instead of throwing raw HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 203.0.113.6:443 token=SECRET")));
    const transport = new OidcIssuerTransport(issuer, "traefik");
    await expect(transport.fetch(issuer + "/.well-known/openid-configuration", "discovery"))
      .rejects.toMatchObject({ status: 503, response: { code: "OIDC_PROVIDER_UNAVAILABLE" } });
  });

  it("rejects private routing that is not pinned to the internal Swarm Traefik service", () => {
    expect(() => new OidcIssuerTransport(issuer, "attacker.example.test")).toThrow();
    expect(() => new OidcIssuerTransport("http://auth.example.test", "traefik")).toThrow();
  });

  it("permits normal issuer requests outside production private routing", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
    await new OidcIssuerTransport(issuer, undefined).fetch(issuer + "/oauth/v2/keys", "jwks");
    const options = mockFetch.mock.calls[0]?.[1] as (RequestInit & { dispatcher?: unknown });
    expect(options.dispatcher).toBeUndefined();
  });
});
