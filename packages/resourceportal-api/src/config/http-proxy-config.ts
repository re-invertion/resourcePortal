export function apiTrustProxy(
  nodeEnvRaw: string | undefined,
  hopsRaw: string | undefined,
) {
  const nodeEnv = (nodeEnvRaw ?? "development").trim().toLowerCase();
  if (nodeEnv !== "production") return false as const;

  const hops = Number.parseInt((hopsRaw ?? "1").trim(), 10);
  if (!Number.isSafeInteger(hops) || hops <= 0) {
    throw new Error("API_TRUST_PROXY_HOPS must be a positive integer");
  }
  if (hops !== 1) {
    throw new Error("API_TRUST_PROXY_HOPS must be exactly 1 in production");
  }
  // Fastify >= 5.12 intentionally fails closed for numeric hop-count trust,
  // because a direct client could spoof X-Forwarded-* by supplying enough
  // entries. ResourcePortal's API is reached through Docker overlay proxies,
  // so trust only RFC1918/ULA immediate peers and stop at the first public IP.
  return "uniquelocal" as const;
}
