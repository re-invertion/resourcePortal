import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FastifyRequest } from "fastify";

/**
 * Only same-process loopback requests can consume this short-lived proof.
 * MCP access tokens are NEVER forwarded to regular API endpoints as bearer
 * credentials. Native tenant and platform guards still run after authentication.
 */
export const MCP_LOOPBACK_HEADER = "x-rp-mcp-loopback-proof";
const ttlMs = 15_000;
const maxOutstanding = 4096;
// A target may be up to 2048 bytes of URL. The JSON/base64url proof adds
// ~1/3 encoding overhead plus fixed claims; 4096 covers every issued proof.
const maxProofHeaderLength = 4096;
const tenantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type DelegationClaims = {
  sub: string;
  tenant: string;
  method: string;
  target: string;
  nonce: string;
  issued: number;
};
type PendingProof = { token: string; expires: number };

@Injectable()
export class McpLoopbackDelegationService {
  private readonly key = randomBytes(32);
  private readonly outstanding = new Map<string, PendingProof>();

  issue(input: {
    userId: string; tenantId: string; method: string;
    target: string; resourceAccessToken: string;
  }) {
    if (!input.resourceAccessToken.startsWith("rpoat_v1_") ||
        !tenantIdPattern.test(input.tenantId) ||
        !this.isScopedTarget(input.target, input.tenantId) ||
        !/^(GET|POST|PATCH|PUT|DELETE)$/.test(input.method) ||
        !input.userId) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    const now = Date.now();
    for (const [nonce, pending] of this.outstanding) {
      if (pending.expires <= now) this.outstanding.delete(nonce);
    }
    if (this.outstanding.size >= maxOutstanding) {
      throw new ServiceUnavailableException("Too many pending MCP loopback requests");
    }
    const nonce = randomBytes(24).toString("base64url");
    const claims: DelegationClaims = {
      sub: input.userId, tenant: input.tenantId, method: input.method,
      target: input.target, nonce, issued: now,
    };
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = this.sign(encoded);
    const proof = `v1.${encoded}.${signature}`;
    if (proof.length > maxProofHeaderLength) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    this.outstanding.set(nonce, {
      token: input.resourceAccessToken, expires: now + ttlMs,
    });
    return proof;
  }

  consume(request: FastifyRequest): { userId: string; tenantId: string; accessToken: string } {
    const header = request.headers[MCP_LOOPBACK_HEADER];
    if (typeof header !== "string" || header.length > maxProofHeaderLength ||
        !this.isLoopback(request.raw?.socket?.remoteAddress)) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    const parts = header.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" ||
        !/^[A-Za-z0-9_-]+$/.test(parts[1]) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    const expected = this.sign(parts[1]);
    if (!timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    let claims: DelegationClaims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as DelegationClaims;
    } catch {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    const pending = this.outstanding.get(claims.nonce);
    // Single use even if the replayed request has the wrong method/path.
    if (typeof claims.nonce === "string") this.outstanding.delete(claims.nonce);
    const now = Date.now();
    if (!pending || pending.expires <= now ||
        typeof claims.issued !== "number" || claims.issued > now ||
        now - claims.issued > ttlMs ||
        !this.isScopedTarget(claims.target, claims.tenant) ||
        request.method !== claims.method ||
        request.url !== claims.target ||
        typeof claims.sub !== "string" || !claims.sub) {
      throw new UnauthorizedException("Invalid MCP loopback delegation");
    }
    return { userId: claims.sub, tenantId: claims.tenant, accessToken: pending.token };
  }

  private sign(value: string) {
    return createHmac("sha256", this.key).update(value).digest("base64url");
  }

  private isScopedTarget(target: string, tenantId: string) {
    if (!tenantIdPattern.test(tenantId) || typeof target !== "string" ||
        target.length > 2048 || !target.startsWith("/api/")) return false;
    let path: string;
    try {
      const url = new URL(target, "http://127.0.0.1");
      if (url.origin !== "http://127.0.0.1" ||
          url.pathname + url.search !== target) return false;
      path = url.pathname;
    } catch { return false; }
    const tenantRoot = `/api/tenants/${tenantId}`;
    return (
      path === tenantRoot ||
      (path.startsWith(`${tenantRoot}/`) &&
        path !== `${tenantRoot}/mcp` &&
        !path.startsWith(`${tenantRoot}/mcp/`)) ||
      path === "/api/platform/bug-reports"
    );
  }

  private isLoopback(address: string | undefined) {
    return address === "127.0.0.1" || address === "::1" ||
      address === "::ffff:127.0.0.1";
  }
}
