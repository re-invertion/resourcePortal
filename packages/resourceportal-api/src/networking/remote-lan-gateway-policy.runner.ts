import { writeGateLeaseSnapshot, type GateLeaseSnapshot } from "./remote-lan-gateway-policy";
import type { GateRuntimeConfig } from "./gate-runtime.types";

/** Invoked ONLY via Docker exec on the gateway container by the trusted worker.
 * No listener, Docker socket, mount, tenant token or remote ingress is added.
 */
async function main() {
  const configB64 = process.env.RP_GATE_CONFIG_B64;
  if (!configB64 || configB64.length > 200_000) throw new Error("Gateway config unavailable");
  const base = JSON.parse(Buffer.from(configB64, "base64").toString("utf8")) as GateRuntimeConfig;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Buffer);
    length += bytes.length;
    if (length > 200_000) throw new Error("Gateway lease policy too large");
    chunks.push(bytes);
  }
  const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GateLeaseSnapshot;
  writeGateLeaseSnapshot(snapshot, base);
}
void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : "Invalid Gateway lease policy");
  process.exitCode = 1;
});
