import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { lookup as dnsLookup } from "node:dns";
import { Agent, type Dispatcher } from "undici";

type OidcStage = "discovery" | "code-exchange" | "jwks" | "userinfo" |
  "refresh" | "revoke" | "registration" | "readiness";

const providerUnavailable = () => new ServiceUnavailableException({
  code: "OIDC_PROVIDER_UNAVAILABLE",
  message: "Identity provider is temporarily unavailable. Please retry sign-in.",
});

/**
 * Connects to the Swarm-local Traefik service while retaining the public
 * issuer URL as the HTTP Host, TLS SNI and certificate verification name.
 * No external resolver overrides or host-specific IPv4 addresses are needed.
 * Only the configured issuer origin may use this privileged private path.
 */
export class OidcIssuerTransport {
  private readonly logger = new Logger(OidcIssuerTransport.name);
  private readonly origin: string;
  private readonly privateAgent?: Agent;

  constructor(
    issuer: string,
    privateRoute: string | undefined,
    // Test-only seam: the production caller always resolves the Swarm
    // service named "traefik". Never sourced from user or environment input.
    privateRouteTestDnsName = "traefik",
  ) {
    const publicIssuer = new URL(issuer);
    if (publicIssuer.username || publicIssuer.password || publicIssuer.hash ||
        publicIssuer.search || publicIssuer.pathname !== "/") {
      throw new ServiceUnavailableException("OIDC issuer URL is invalid");
    }
    this.origin = publicIssuer.origin;
    if (privateRoute) {
      if (privateRoute !== "traefik" || publicIssuer.protocol !== "https:") {
        throw new ServiceUnavailableException("OIDC private TLS route configuration is invalid");
      }
      // Docker Swarm DNS resolves the service VIP on the dedicated rp-oidc
      // overlay. The connection still carries the ORIGINAL issuer hostname,
      // so undici's TLS validation and SNI are never disabled or replaced.
      this.privateAgent = new Agent({
        connect: {
          lookup: (_hostname, options, callback) =>
            dnsLookup(privateRouteTestDnsName, options, callback),
        },
      });
    }
  }

  async fetch(url: string | URL, stage: OidcStage, options: RequestInit = {}): Promise<Response> {
    const endpoint = new URL(String(url));
    if (endpoint.origin !== this.origin || endpoint.username || endpoint.password ||
        !["https:", "http:"].includes(endpoint.protocol)) {
      this.logger.warn(JSON.stringify({ code: "OIDC_ENDPOINT_REJECTED", stage }));
      throw new ServiceUnavailableException("Identity provider endpoint is not trusted");
    }
    // Never follow redirects: authorization codes, client secrets and bearer
    // tokens must not escape to a second origin, even when it returns 3xx.
    try {
      const response = await fetch(endpoint.toString(), {
        ...options,
        redirect: "manual",
        ...(this.privateAgent ? { dispatcher: this.privateAgent as Dispatcher } : {}),
      } as RequestInit);
      if (response.status >= 300 && response.status < 400) {
        this.logger.warn(JSON.stringify({ code: "OIDC_REDIRECT_REJECTED", stage }));
        throw providerUnavailable();
      }
      return response;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(JSON.stringify({
        code: "OIDC_CONNECTIVITY_FAILED", stage,
        route: this.privateAgent ? "private-tls" : "default",
      }));
      throw providerUnavailable();
    }
  }

  assertIssuerEndpoint(url: string, stage: OidcStage): void {
    let endpoint: URL;
    try { endpoint = new URL(url); } catch {
      throw new ServiceUnavailableException("OIDC metadata contains an invalid endpoint");
    }
    if (endpoint.origin !== this.origin || endpoint.username || endpoint.password) {
      this.logger.warn(JSON.stringify({ code: "OIDC_METADATA_ENDPOINT_REJECTED", stage }));
      throw new ServiceUnavailableException("OIDC metadata endpoint is not trusted");
    }
  }
}
