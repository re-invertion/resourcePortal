export function shouldRateLimitRequest(url: string) {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname !== "/api/health/live";
}

/**
 * Container shells generate legitimate sustained traffic. Keep a separate,
 * finite per-IP quota so multiple authenticated terminal sessions cannot
 * exhaust the normal API quota shared with other users behind a NAT.
 * This does not bypass the rate limiter or authentication/CSRF guards.
 */
export function isContainerTerminalRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return /^\/api\/tenants\/[0-9a-f-]{36}\/app-groups\/[0-9a-f-]{36}\/single-apps\/[0-9a-f-]{36}\/terminal\/(?:containers|start|read|write|resize|close|execute)$/.test(pathname);
}
