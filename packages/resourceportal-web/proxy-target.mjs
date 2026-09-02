export function resolveApiTarget(requestUrl, apiOrigin) {
  const localRequest = new URL(requestUrl ?? "/api", "http://resourceportal.local");
  return new URL(`${localRequest.pathname}${localRequest.search}`, apiOrigin).toString();
}
