import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { networkComposeAlias } from "./network-runtime-names";
import type { GateRuntimeConfig, GateRuntimeLanAttachment } from "./gate-runtime.types";

export const GATE_CONTAINER_PORT = 51820;
export type GateStackNetwork = {
  id: string;
  swarmNetworkName: string;
  overlayCidr: string;
};
export type GateStackInput = {
  gateId: string;
  image: string;
  publishedPort: number;
  serverTunnelAddress: string;
  clientTunnelAddress: string;
  peerPublicKey: string;
  privateSecretName: string;
  networks: GateStackNetwork[];
  remoteLanAttachments: GateRuntimeLanAttachment[];
};

/** Only app-scoped Ethernet grants enter the runtime config. No routed LAN CIDRs. */
export function gateRuntimeConfig(input: GateStackInput): GateRuntimeConfig {
  return {
    gateId: input.gateId,
    listenPort: GATE_CONTAINER_PORT,
    serverTunnelAddress: input.serverTunnelAddress,
    clientTunnelAddress: input.clientTunnelAddress,
    peerPublicKey: input.peerPublicKey,
    privateKeyPath: "/run/secrets/gate-private-key",
    rpOverlayCidrs: [...input.networks.map(network => network.overlayCidr)].sort(),
    remoteLanAttachments: [...input.remoteLanAttachments].sort((a,b) =>
      a.attachmentId.localeCompare(b.attachmentId)),
  };
}

export function gateStackDigest(input: GateStackInput) {
  const canonical = {
    ...input,
    remoteLanAttachments: [...input.remoteLanAttachments].sort((a,b) =>
      a.attachmentId.localeCompare(b.attachmentId)),
    networks: [...input.networks].sort((a,b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function renderGateStack(input: GateStackInput) {
  const runtime = gateRuntimeConfig(input);
  const digest = gateStackDigest(input);
  const networks = Object.fromEntries(input.networks.map(network => [
    networkComposeAlias(network.id),
    { external: true, name: network.swarmNetworkName },
  ]));
  const selected = Object.fromEntries(input.networks.map(network => [
    networkComposeAlias(network.id), {},
  ]));
  return stringify({
    version: "3.9",
    services: {
      gateway: {
        image: input.image,
        user: "0",
        cap_add: ["NET_ADMIN","NET_RAW"],
        command: ["node","dist/src/networking/remote-lan-gateway.runner.js"],
        environment: {
          RP_REMOTE_LAN_GATEWAY_ENABLED: input.remoteLanAttachments.length ? "true" : "false",
          RP_GATE_CONFIG_B64: Buffer.from(JSON.stringify(runtime), "utf8").toString("base64"),
        },
        secrets: [{ source: "gate_private_key", target: "gate-private-key" }],
        networks: selected,
        ports: [{
          target: GATE_CONTAINER_PORT, published: input.publishedPort,
          protocol: "udp", mode: "ingress",
        }],
        deploy: {
          replicas: 1,
          labels: {
            "resourceportal.gate.id": input.gateId,
            "resourceportal.gate.digest": digest,
          },
          placement: {
            constraints: ["node.labels.rp.node.control-plane == true"],
          },
          restart_policy: { condition: "any" },
        },
      },
    },
    networks,
    secrets: { gate_private_key: { external: true, name: input.privateSecretName } },
  }, { lineWidth: 0 });
}
