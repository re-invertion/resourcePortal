/** Only retry requests proven idempotent during MCP OAuth startup reconciliation. */
const TRANSIENT = new Set([429, 502, 503, 504]);

export function isRetryableMcpReconcileRequest(path: string, method: "POST" | "PUT"): boolean {
  return method === "PUT" || (method === "POST" && (
    path.endsWith("/_search") ||
    path === "/zitadel.application.v2.ApplicationService/UpdateApplication"
  ));
}

export async function retryMcpStartupRequest(
  send: (signal: AbortSignal) => Promise<Response>,
  options: { maxElapsedMs?: number; initialDelayMs?: number; maxAttempts?: number } = {},
): Promise<Response> {
  const limitMs = options.maxElapsedMs ?? 30_000;
  const initialDelay = options.initialDelayMs ?? 400;
  const attempts = options.maxAttempts ?? 7;
  if (!(Number.isFinite(limitMs) && limitMs > 0 && attempts > 0)) {
    throw new Error("Invalid ZITADEL MCP retry budget");
  }
  const deadline = Date.now() + limitMs;
  let lastCause = "transport unavailable";
  for (let index = 0; index < attempts; index++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await send(AbortSignal.timeout(Math.min(8000, Math.max(1, remaining))));
      if (!TRANSIENT.has(response.status) || index + 1 === attempts) return response;
      lastCause = `HTTP ${response.status}`;
      await response.body?.cancel(); // do not leak sockets between retries
    } catch {
      // Abort/transport failures during startup are transient only inside the bounded budget.
      if (index + 1 === attempts) break;
      lastCause = "transport unavailable";
    }
    const wait = Math.min(2500, initialDelay * 2 ** index, Math.max(0, deadline - Date.now()));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw new Error(`ZITADEL MCP startup retry deadline exceeded (last=${lastCause})`);
}
