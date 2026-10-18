import { randomBytes } from "node:crypto";
import { parseIpv4Cidr, containsIpv4 } from "./network-addressing";

export const DISCOVERY_TUNNEL_PORT = 53540;
export const DISCOVERY_MAX_PAYLOAD = 1200;
export const DISCOVERY_SESSION_TTL_MS = 5000;

export type DiscoveryProtocol = "mdns" | "ssdp";
export type DiscoveryWireMessage = {
  version: 1;
  kind: "query" | "response";
  session: string;
  protocol?: DiscoveryProtocol;
  payload: string;
};

export function validDiscoveryQuery(protocol: DiscoveryProtocol, payload: Buffer) {
  if (payload.length < 12 || payload.length > DISCOVERY_MAX_PAYLOAD) return false;
  if (protocol === "mdns") {
    // RFC 6762: DNS query (QR=0), with at least one question.
    return (payload[2] & 0x80) === 0 && payload.readUInt16BE(4) > 0;
  }
  const text = payload.toString("latin1");
  return text.startsWith("M-SEARCH * HTTP/1.1\r\n") &&
    /\r\nMAN:\s*"?ssdp:discover"?\r\n/i.test(text) &&
    text.endsWith("\r\n\r\n");
}

export function validDiscoveryResponse(protocol: DiscoveryProtocol, payload: Buffer) {
  if (payload.length < 12 || payload.length > DISCOVERY_MAX_PAYLOAD) return false;
  return protocol === "mdns"
    ? (payload[2] & 0x80) !== 0
    : payload.toString("latin1").startsWith("HTTP/1.1 200");
}

export function encodeDiscoveryEnvelope(
  value: Omit<DiscoveryWireMessage, "version" | "payload"> & { payload: Buffer },
) {
  if (value.payload.length > DISCOVERY_MAX_PAYLOAD) throw new Error("Oversized discovery payload");
  return Buffer.from(JSON.stringify({
    version: 1, kind: value.kind, session: value.session,
    protocol: value.protocol,
    payload: value.payload.toString("base64"),
  }), "utf8");
}

export function decodeDiscoveryEnvelope(raw: Buffer): DiscoveryWireMessage | undefined {
  if (raw.length > 4000 || raw.length < 12) return undefined;
  try {
    const value = JSON.parse(raw.toString("utf8")) as Partial<DiscoveryWireMessage>;
    if (value.version !== 1 || !["query", "response"].includes(value.kind ?? "") ||
      !/^[0-9a-f]{24}$/.test(value.session ?? "") ||
      typeof value.payload !== "string" || value.payload.length > 2000 ||
      (value.protocol !== undefined && !["mdns", "ssdp"].includes(value.protocol))) {
      return undefined;
    }
    const bytes = Buffer.from(value.payload, "base64");
    if (bytes.length === 0 || bytes.length > DISCOVERY_MAX_PAYLOAD ||
      bytes.toString("base64") !== value.payload) return undefined;
    return value as DiscoveryWireMessage;
  } catch {
    return undefined;
  }
}

export function newDiscoverySession() { return randomBytes(12).toString("hex"); }

export function isAttachedOverlaySource(
  source: string, cidrs: string[],
) {
  return cidrs.some(cidr => {
    const parsed = parseIpv4Cidr(cidr);
    return parsed ? containsIpv4(parsed, source) : false;
  });
}

export class DiscoveryRateLimiter {
  private readonly counts = new Map<string, { since: number; count: number }>();
  canSend(source: string, now: number) {
    const previous = this.counts.get(source);
    if (!previous || now - previous.since >= 1000) {
      this.counts.set(source, { since: now, count: 1 });
      return true;
    }
    if (previous.count >= 8) return false;
    previous.count++;
    return true;
  }
  prune(now: number) {
    for (const [key, value] of this.counts) {
      if (now - value.since > 2000) this.counts.delete(key);
    }
  }
}
