export type AppRoute =
  | { kind: "public"; page: "login" | "register" | "recover" | "health" }
  | { kind: "tenants" }
  | { kind: "tenant"; tenantId: string; section: string; resourceId?: string }
  | { kind: "platform"; section: string; resourceId?: string }
  | { kind: "not-found" };

function segments(pathname: string) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export function parseRoute(pathname: string): AppRoute {
  const parts = segments(pathname);
  if (parts.length === 0 || parts[0] === "login") return { kind: "public", page: "login" };
  if (parts[0] === "register") return { kind: "public", page: "register" };
  if (parts[0] === "recover") return { kind: "public", page: "recover" };
  if (parts[0] === "health") return { kind: "public", page: "health" };
  if (parts[0] === "tenants" && parts.length === 1) return { kind: "tenants" };
  if (parts[0] === "tenants" && parts[1] && parts[2]) {
    return {
      kind: "tenant",
      tenantId: parts[1],
      section: parts[2],
      resourceId: parts[3],
    };
  }
  if (parts[0] === "platform" && parts[1]) {
    return { kind: "platform", section: parts[1], resourceId: parts[2] };
  }
  return { kind: "not-found" };
}

export function tenantHref(tenantId: string, section: string, resourceId?: string) {
  return `/tenants/${encodeURIComponent(tenantId)}/${section}${resourceId ? `/${encodeURIComponent(resourceId)}` : ""}`;
}
