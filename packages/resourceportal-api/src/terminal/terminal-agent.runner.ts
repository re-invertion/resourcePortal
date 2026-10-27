/** Swarm global worker-node terminal agent. Only reachable on rp-control overlay. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { ContainerTerminalWorker } from "./terminal-worker";

export function startTerminalAgent(port: number, secret: string) {
  if (!secret || secret.length < 16) throw new Error("Terminal node agent requires authenticated Worker token");
  const terminal = new ContainerTerminalWorker();
  const server = createServer((request, reply) => {
    void (async () => {
      const deny = (status: number, message?: string) => {
        reply.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify({ message: message ?? "Request denied" }));
      };
      if (request.method !== "POST" || request.url !== "/internal/container-terminal") return deny(404);
      const provided = typeof request.headers["x-internal-token"] === "string" ? request.headers["x-internal-token"] : "";
      const actual = Buffer.from(secret);
      const candidate = Buffer.from(provided);
      if (candidate.length !== actual.length || !timingSafeEqual(candidate, actual)) return deny(403);
      let body = "";
      try {
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 16384) return deny(413);
        }
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value)) return deny(400);
        const result = await terminal.handle(value as Record<string, unknown>);
        reply.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify(result));
      } catch (error) { if (!reply.writableEnded) deny(422, error instanceof Error ? error.message : "Terminal unavailable"); }
    })();
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 8_000;
  server.listen(port, "0.0.0.0");
  return server;
}

if (require.main === module) {
  const file = process.env.INTERNAL_WORKER_TOKEN_FILE;
  if (!file) throw new Error("INTERNAL_WORKER_TOKEN_FILE is required");
  const port = Number(process.env.RESOURCEPORTAL_TERMINAL_NODE_PORT ?? "3102");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid terminal node port");
  const server = startTerminalAgent(port, readFileSync(file, "utf8").trim());
  process.on("SIGTERM", () => server.close());
  console.log("ResourcePortal terminal node agent started on internal overlay port");
}
