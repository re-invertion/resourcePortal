import { isIP } from "node:net";

export function resolveApiTarget(requestUrl, apiOrigin) {
  const localRequest = new URL(requestUrl ?? "/api", "http://resourceportal.local");
  return new URL(`${localRequest.pathname}${localRequest.search}`, apiOrigin).toString();
}

export function resolveProxyHeaders(headers, env = process.env) {
  const resolved = { ...headers };
  const production = (env.NODE_ENV ?? "development").trim().toLowerCase() === "production";

  if (!production && env.RESOURCE_PORTAL_DEV_USER_ID) {
    resolved["x-dev-user-id"] = env.RESOURCE_PORTAL_DEV_USER_ID;
  }

  if (production) {
    const clientIp = canonicalForwardedClientIp(headers["x-forwarded-for"]);
    delete resolved.forwarded;
    delete resolved["x-forwarded-for"];
    delete resolved["x-forwarded-host"];
    delete resolved["x-forwarded-port"];
    delete resolved["x-forwarded-proto"];
    delete resolved["x-dev-user-id"];

    if (clientIp) resolved["x-forwarded-for"] = clientIp;
    resolved["x-forwarded-proto"] = "https";
    if (typeof headers.host === "string" && headers.host.length <= 255) {
      resolved["x-forwarded-host"] = headers.host;
    }
  }

  return resolved;
}

export function canonicalForwardedClientIp(value) {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (typeof raw !== "string") return undefined;
  const candidates = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const candidate = stripIpv6Brackets(candidates.at(-1) ?? "");
  return isIP(candidate) ? candidate : undefined;
}

function stripIpv6Brackets(value) {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}
