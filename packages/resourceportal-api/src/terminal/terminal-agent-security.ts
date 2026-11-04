import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";

const maxSkewMs = 30_000;
const maxOutstandingNonces = 16_384;
const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const noncePattern = /^[0-9a-f]{32}$/;
const signaturePattern = /^[0-9a-f]{64}$/;
const productionStack = /^[a-zA-Z0-9_.-]{1,80}$/;

export type AgentSecurityHeaders = {
  "x-rp-agent-timestamp": string;
  "x-rp-agent-nonce": string;
  "x-rp-agent-target": string;
  "x-rp-agent-signature": string;
};

function canonical(method: string, path: string, body: string, timestamp: string, nonce: string, target: string): string {
  return ["rp-agent-v1", method, path, timestamp, nonce, target, createHash("sha256").update(body).digest("hex")].join("\n");
}

/** The broad internal Worker secret never leaves the Worker in a node-agent request.
 * Every MAC is bound to a specific agent IP, endpoint, body and short lifetime. */
export function signedAgentHeaders(
  secret: string, path: string, body: string, target: string, now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
): AgentSecurityHeaders {
  if (secret.length < 16 || !path.startsWith("/internal/") || !ipv4.test(target) ||
      !noncePattern.test(nonce) || !Number.isSafeInteger(now)) {
    throw new Error("Invalid terminal agent signing input");
  }
  const timestamp = String(now);
  return {
    "x-rp-agent-timestamp": timestamp,
    "x-rp-agent-nonce": nonce,
    "x-rp-agent-target": target,
    "x-rp-agent-signature": createHmac("sha256", secret)
      .update(canonical("POST", path, body, timestamp, nonce, target)).digest("hex"),
  };
}

function singleHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

/** Every node keeps its own bounded replay window. Requests are single-use,
 * including read-only probes; rejects all old bearer headers. */
export class AgentRequestVerifier {
  private readonly used = new Map<string, number>();
  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new Error("Terminal node agent requires authenticated Worker token");
  }

  verify(
    headers: Record<string, string | string[] | undefined>,
    method: string | undefined, path: string, body: string,
    localAddress: string | undefined, now = Date.now(),
  ): boolean {
    const timestamp = singleHeader(headers, "x-rp-agent-timestamp");
    const nonce = singleHeader(headers, "x-rp-agent-nonce");
    const target = singleHeader(headers, "x-rp-agent-target");
    const signature = singleHeader(headers, "x-rp-agent-signature");
    const local = localAddress?.startsWith("::ffff:") ? localAddress.slice(7) : localAddress;
    if (method !== "POST" || !/^\d{13}$/.test(timestamp) || !noncePattern.test(nonce) ||
        !signaturePattern.test(signature) || !ipv4.test(target) || local !== target ||
        Math.abs(now - Number(timestamp)) > maxSkewMs || this.used.has(nonce)) return false;
    const expected = createHmac("sha256", this.secret)
      .update(canonical("POST", path, body, timestamp, nonce, target)).digest();
    const provided = Buffer.from(signature, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
    // A signature is consumed once, even if the underlying operation fails.
    for (const [id, expiry] of this.used) if (expiry < now) this.used.delete(id);
    if (this.used.size >= maxOutstandingNonces) return false;
    this.used.set(nonce, now + maxSkewMs * 2);
    return true;
  }
}

type SwarmNetwork = {
  Name?: unknown;
  Driver?: unknown;
  Scope?: unknown;
  Attachable?: unknown;
  Internal?: unknown;
  Options?: Record<string, unknown> | null;
};

export function isEncryptedTerminalOverlay(value: unknown, name: string): boolean {
  if (!value || typeof value !== "object") return false;
  const network = value as SwarmNetwork;
  if (network.Name !== name || network.Driver !== "overlay" || network.Scope !== "swarm" ||
      network.Attachable !== false) return false;
  const options = network.Options;
  return !!options && Object.prototype.hasOwnProperty.call(options, "encrypted") &&
    (options.encrypted === "" || options.encrypted === "true");
}

/** Inspect the effective Swarm network, not only the Compose template. Never
 * send shell contents or node inventory across a missing/plaintext overlay. */
export async function assertEncryptedTerminalOverlay(stack: string): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  if (!productionStack.test(stack)) throw new Error("Invalid terminal control plane stack");
  const name = `${stack}_rp-terminal-secure`;
  const value = await new Promise<unknown>((resolve, reject) => {
    const req = httpRequest({
      socketPath: "/var/run/docker.sock",
      path: `/v1.43/networks/${encodeURIComponent(name)}`,
      method: "GET", timeout: 3000,
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Secure terminal overlay unavailable")); return; }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 65536) { response.destroy(new Error("Network inspect too large")); }
      });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(body) as unknown); } catch { reject(new Error("Invalid network inspection")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Network inspect timeout")));
    req.on("error", reject);
    req.end();
  });
  if (!isEncryptedTerminalOverlay(value, name))
    throw new Error("Terminal agent denied: Swarm network encryption is not verified");
}
