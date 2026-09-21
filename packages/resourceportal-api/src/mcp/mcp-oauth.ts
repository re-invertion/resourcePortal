import { FastifyReply, FastifyRequest } from "fastify";

export function isTenantMcpRequest(request: FastifyRequest) {
  return /^\/api\/tenants\/[^/?]+\/mcp(?:[/?]|$)/.test(request.url);
}

export function requestOrigin(request: FastifyRequest) {
  const forwardedProto = headerValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const forwardedHost = headerValue(request.headers["x-forwarded-host"])?.split(",")[0]?.trim();
  const protocol = forwardedProto || request.protocol || "https";
  const host = forwardedHost || request.headers.host;
  if (!host) return undefined;
  return `${protocol}://${host}`;
}

export function protectedResourceMetadataUrl(request: FastifyRequest, tenantId: string) {
  const origin = requestOrigin(request);
  if (!origin) return undefined;
  return `${origin}/.well-known/oauth-protected-resource/api/tenants/${encodeURIComponent(tenantId)}/mcp`;
}

export function applyMcpBearerChallenge(
  request: FastifyRequest,
  reply: FastifyReply,
  tenantId?: string,
) {
  const resolvedTenantId = tenantId ?? (request.params as { tenantId?: string }).tenantId;
  if (!resolvedTenantId) return;
  const metadata = protectedResourceMetadataUrl(request, resolvedTenantId);
  if (!metadata) return;
  reply.header("www-authenticate", `Bearer resource_metadata="${metadata}"`);
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
