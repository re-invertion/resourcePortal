/**
 * A route in the RP-owned table alone is not proof that the kernel would use
 * it. Verify the effective FIB decision after every route update.
 */
export function effectiveLanRouteMatches(
  routeGetJson: unknown,
  expectedGateway: string,
  expectedInterface: string,
): boolean {
  if (!Array.isArray(routeGetJson) || routeGetJson.length === 0) return false;
  const entries: unknown[] = routeGetJson;
  const route: unknown = entries[0];
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  const item = route as { gateway?: unknown; dev?: unknown; type?: unknown };
  return item.gateway === expectedGateway &&
    item.dev === expectedInterface &&
    (item.type === undefined || item.type === "unicast");
}
