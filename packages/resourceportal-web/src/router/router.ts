export type PublicPage = "login" | "register" | "recover" | "health";

export type AppRoute =
  | { kind: "public"; page: PublicPage }
  | { kind: "tenants" }
  | { kind: "tenant"; tenantId: string; section: string; resourceId?: string; segments?: string[] }
  | { kind: "platform"; section: string; resourceId?: string; segments?: string[] }
  | { kind: "not-found" };

function decode(part: string) {
  try { return decodeURIComponent(part); } catch { return part; }
}

function pathParts(pathname: string) {
  const clean = pathname.split(/[?#]/, 1)[0];
  return clean.split("/").filter(Boolean).map(decode);
}

export function parseRoute(pathname: string): AppRoute {
  const parts = pathParts(pathname);
  if (parts.length === 0) return { kind: "tenants" };
  if (parts.length === 1 && ["login", "register", "recover", "health"].includes(parts[0])) return { kind: "public", page: parts[0] as PublicPage };
  if (parts.length === 1 && parts[0] === "tenants") return { kind: "tenants" };
  if (parts[0] === "tenants" && parts[1]) {
    const section = parts[2] ?? "overview";
    const segments = parts.slice(3);
    return { kind: "tenant", tenantId: parts[1], section, resourceId: segments[0], segments };
  }
  if (parts[0] === "platform") {
    const section = parts[1] ?? "overview";
    const segments = parts.slice(2);
    return { kind: "platform", section, resourceId: segments[0], segments };
  }
  return { kind: "not-found" };
}

function encodePathPart(value: string) { return encodeURIComponent(value); }
function suffix(parts: Array<string | undefined>) {
  const encoded = parts.filter((part): part is string => typeof part === "string" && part.length > 0).map((part) => part.split("/").filter(Boolean).map(encodePathPart).join("/"));
  return encoded.length ? `/${encoded.join("/")}` : "";
}

export function tenantHref(tenantId: string, section = "overview", resourceId?: string) {
  return `/tenants/${encodePathPart(tenantId)}/${encodePathPart(section)}${suffix([resourceId])}`;
}

export function tenantResourceHref(tenantId: string, section: string, ...segments: string[]) {
  return `/tenants/${encodePathPart(tenantId)}/${encodePathPart(section)}${suffix(segments)}`;
}

export function appGroupHref(tenantId: string, appGroupId: string, subpath?: string) {
  return tenantResourceHref(tenantId, "app-groups", appGroupId, ...(subpath ? subpath.split("/").filter(Boolean) : []));
}

export function applicationHref(tenantId: string, appGroupId: string, appId: string, subpath?: string) {
  return appGroupHref(tenantId, appGroupId, `apps/${appId}${subpath ? `/${subpath}` : ""}`);
}

export function platformHref(section = "overview", ...segments: string[]) {
  return `/platform/${encodePathPart(section)}${suffix(segments)}`;
}
