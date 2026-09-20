export function shouldRateLimitRequest(url: string) {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname !== "/api/health/live";
}
