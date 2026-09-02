export function resolveApiTarget(requestUrl, apiOrigin) {
  const localRequest = new URL(requestUrl ?? "/api", "http://resourceportal.local");
  return new URL(`${localRequest.pathname}${localRequest.search}`, apiOrigin).toString();
}

export function resolveProxyHeaders(headers, env = process.env) {
  const resolved = { ...headers };
  if ((env.NODE_ENV ?? "development") !== "production" && env.RESOURCE_PORTAL_DEV_USER_ID) {
    resolved["x-dev-user-id"] = env.RESOURCE_PORTAL_DEV_USER_ID;
  }
  return resolved;
}
