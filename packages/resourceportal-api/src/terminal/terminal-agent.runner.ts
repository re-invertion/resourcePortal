/** Swarm global worker-node terminal agent. Only reachable on the encrypted dedicated overlay. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { AgentRequestVerifier, assertEncryptedTerminalOverlay } from "./terminal-agent-security";
import { ContainerTerminalWorker } from "./terminal-worker";
import { probeSwarmNodeGpuRuntime, probeSwarmNodeGpuContainerUsage, preloadPinnedGpuProbeImage } from "../platform-infrastructure/nvidia-gpu-node-probe";
import { probeSwarmNodeCapacity } from "../capacity/capacity-node-probe";

export function startTerminalAgent(port: number, secret: string) {
  if (!secret || secret.length < 16) throw new Error("Terminal node agent requires authenticated Worker token");
  const terminal = new ContainerTerminalWorker();
  const verifier = new AgentRequestVerifier(secret);
  const server = createServer((request, reply) => {
    void (async () => {
      const deny = (status: number, message?: string) => {
        reply.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify({ message: message ?? "Request denied" }));
      };
      if (request.method !== "POST" || !["/internal/container-terminal", "/internal/gpu-probe", "/internal/gpu-usage", "/internal/capacity-probe"].includes(request.url ?? "")) return deny(404);
      let body = "";
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length;
          if (bytes > 16384) return deny(413);
          chunks.push(part);
        }
        // A multi-byte shell command can straddle TCP packets. Decode only
        // after assembling the exact signed UTF-8 body.
        body = Buffer.concat(chunks).toString("utf8");
      } catch { return deny(400); }
      if (!verifier.verify(request.headers, request.method, request.url ?? "", body, request.socket.localAddress))
        return deny(403);
      if (request.url === "/internal/gpu-probe") {
        // Only the authenticated infrastructure Worker can request a bounded
        // local probe. No caller-supplied image, target, command or arguments.
        const result = await probeSwarmNodeGpuRuntime();
        reply.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify(result));
        return;
      }
      if (request.url === "/internal/gpu-usage") {
        // Authenticated, read-only proof of locally RUNNING GPU containers.
        // No user-defined commands, filters, image, or target are accepted.
        const result = await probeSwarmNodeGpuContainerUsage();
        reply.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify(result));
        return;
      }
      if (request.url === "/internal/capacity-probe") {
        // Read-only node telemetry. The request accepts no caller-supplied
        // path, command, container or process selector.
        const result = await probeSwarmNodeCapacity();
        reply.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        reply.end(JSON.stringify(result));
        return;
      }
      try {
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
  if (process.env.NODE_ENV === "production") {
    // Pinned image preload is best effort. Failed pulls keep GPUs unavailable,
    // never bypass runtime probe or affect container terminal availability.
    void preloadPinnedGpuProbeImage().catch(() => false);
  }
  return server;
}

if (require.main === module) {
  const file = process.env.INTERNAL_WORKER_TOKEN_FILE;
  if (!file) throw new Error("INTERNAL_WORKER_TOKEN_FILE is required");
  const port = Number(process.env.RESOURCEPORTAL_TERMINAL_NODE_PORT ?? "3102");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid terminal node port");
  const stack = process.env.RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME ?? "resourceportal-control-plane";
  void assertEncryptedTerminalOverlay(stack).then(() => {
    const server = startTerminalAgent(port, readFileSync(file, "utf8").trim());
    process.on("SIGTERM", () => server.close());
    console.log("ResourcePortal terminal node agent started on verified encrypted overlay");
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unverified terminal agent network");
    process.exitCode = 1;
  });
}
