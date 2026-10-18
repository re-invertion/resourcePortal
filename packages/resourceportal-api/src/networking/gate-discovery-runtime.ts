import { Logger } from "@nestjs/common";
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { GateRuntimeConfig } from "./gate-runtime.types";
import {
  DISCOVERY_MAX_PAYLOAD, DISCOVERY_SESSION_TTL_MS, DISCOVERY_TUNNEL_PORT,
  decodeDiscoveryEnvelope, encodeDiscoveryEnvelope, isAttachedOverlaySource,
  newDiscoverySession, validDiscoveryQuery, validDiscoveryResponse,
  DiscoveryRateLimiter, type DiscoveryProtocol,
} from "./gate-discovery-relay";

const logger = new Logger("GateDiscoveryRelay");
type Session = {
  sourceAddress: string;
  sourcePort: number;
  protocol: DiscoveryProtocol;
  expires: number;
  responses: number;
};

export async function startGateDiscoveryRelay(
  config: GateRuntimeConfig,
  resolveTasks: (alias: string) => string[],
) {
  const rules = config.discoveryRules ?? [];
  if (rules.length === 0) return () => undefined;
  const attached = new Set(config.mappings.map(item => item.attachmentAlias));
  for (const rule of rules) {
    if (!attached.has(rule.attachmentAlias)) throw new Error("Invalid discovery application");
  }
  const peer = config.clientTunnelAddress.split("/")[0];
  if (!peer) throw new Error("Discovery peer tunnel address is missing");
  const sockets: Socket[] = [];
  const sessions = new Map<string, Session>();
  const rate = new DiscoveryRateLimiter();
  const tunnel = createSocket({ type: "udp4", reuseAddr: true });
  tunnel.on("error", error => logger.error("Tunnel discovery socket: " + error.message));
  await new Promise<void>((resolve, reject) => {
    tunnel.once("error", reject);
    tunnel.bind(DISCOVERY_TUNNEL_PORT, "0.0.0.0", () => {
      tunnel.off("error", reject);
      resolve();
    });
  });

  const interfaces = Object.values(networkInterfaces()).flatMap(items => items ?? [])
    .filter(item =>
      item.family === "IPv4" &&
      isAttachedOverlaySource(item.address, config.rpOverlayCidrs ?? []),
    );
  const subscribe = async (protocol: DiscoveryProtocol, port: number, group: string) => {
    if (!rules.some(rule => rule.protocol === protocol) || interfaces.length === 0) return undefined;
    const socket = createSocket({type: "udp4", reuseAddr: true});
    socket.on("error", error => logger.error(protocol + " discovery socket: " + error.message));
    await new Promise<void>((resolve,reject) => {
      socket.once("error", reject);
      socket.bind(port, "0.0.0.0", () => { socket.off("error",reject); resolve(); });
    });
    let joined = 0;
    for (const iface of interfaces) {
      try {
        socket.addMembership(group, iface.address);
        joined++;
      } catch (error) {
        logger.warn("Unable to join " + group + " on " + iface.address + ": " + String(error));
      }
    }
    if (!joined) { socket.close(); return undefined; }
    sockets.push(socket);
    return socket;
  };
  const mdns = await subscribe("mdns", 5353, "224.0.0.251");
  const ssdp = await subscribe("ssdp", 1900, "239.255.255.250");
  tunnel.on("message", (raw, remote: RemoteInfo) => {
    if (remote.address !== peer) return;
    const envelope = decodeDiscoveryEnvelope(raw);
    if (!envelope || envelope.kind !== "response") return;
    const session = sessions.get(envelope.session);
    if (!session || session.expires < Date.now() || session.responses >= 20) return;
    const payload = Buffer.from(envelope.payload, "base64");
    if (!validDiscoveryResponse(session.protocol, payload)) return;
    const sock = session.protocol === "mdns" ? mdns : ssdp;
    if (!sock) return;
    session.responses++;
    sock.send(payload, session.sourcePort, session.sourceAddress);
  });


  const receive = (protocol: DiscoveryProtocol) => (payload: Buffer, source: RemoteInfo) => {
    if (!validDiscoveryQuery(protocol, payload) ||
      payload.length > DISCOVERY_MAX_PAYLOAD ||
      !isAttachedOverlaySource(source.address, config.rpOverlayCidrs ?? [])) return;
    if (!rules.some(rule => rule.protocol === protocol &&
      resolveTasks(rule.attachmentAlias).includes(source.address))) return;
    const now = Date.now();
    if (!rate.canSend(source.address, now)) return;
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
    rate.prune(now);
    if (sessions.size >= 256) return;
    const session = newDiscoverySession();
    sessions.set(session,{
      sourceAddress: source.address, sourcePort: source.port,
      protocol, expires: now + DISCOVERY_SESSION_TTL_MS, responses: 0,
    });
    tunnel.send(encodeDiscoveryEnvelope({
      kind: "query", session, protocol, payload,
    }),DISCOVERY_TUNNEL_PORT,peer);
  };
  mdns?.on("message", receive("mdns"));
  ssdp?.on("message", receive("ssdp"));
  logger.log("Scoped discovery relay enabled for " + rules.length + " application protocols");
  return () => { mdns?.close(); ssdp?.close(); tunnel.close(); };
}
