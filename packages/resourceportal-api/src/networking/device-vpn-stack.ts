import { createHash } from "node:crypto";
import { stringify } from "yaml";
import {
  networkAttachmentAlias,
  networkComposeAlias,
} from "./network-runtime-names";
import type { DeviceVpnRuntimeConfig } from "./device-vpn-runtime.types";

export const DEVICE_VPN_CONTAINER_PORT = 51820;

export type DeviceVpnStackNetwork = {
  id: string;
  swarmNetworkName: string;
  overlayCidr: string;
  attachments: Array<{
    id: string;
    address: string;
  }>;
};

export type DeviceVpnStackPeer = {
  deviceId: string;
  publicKey: string;
  assignedAddress: string;
  networkIds: string[];
};

export type DeviceVpnStackInput = {
  gatewayId: string;
  image: string;
  publishedPort: number;
  serverTunnelAddress: string;
  privateSecretName: string;
  runtimeTokenSecretName: string;
  heartbeatUrl: string;
  peers: DeviceVpnStackPeer[];
  networks: DeviceVpnStackNetwork[];
};

export function deviceVpnRuntimeConfig(
  input: DeviceVpnStackInput,
): DeviceVpnRuntimeConfig {
  return {
    gatewayId: input.gatewayId,
    listenPort: DEVICE_VPN_CONTAINER_PORT,
    serverTunnelAddress: input.serverTunnelAddress,
    privateKeyPath: "/run/secrets/device-vpn-private-key",
    runtimeTokenPath: "/run/secrets/device-vpn-runtime-token",
    heartbeatUrl: input.heartbeatUrl,
    peers: input.peers.map((peer) => ({
      ...peer,
      networkIds: [...peer.networkIds].sort(),
    })),
    mappings: input.networks.flatMap((network) =>
      network.attachments.map((attachment) => ({
        networkId: network.id,
        stableAddress: attachment.address,
        overlayCidr: network.overlayCidr,
        attachmentAlias: networkAttachmentAlias(attachment.id),
      })),
    ),
  };
}

export function deviceVpnStackDigest(input: DeviceVpnStackInput) {
  const canonical = {
    ...input,
    peers: [...input.peers]
      .map((peer) => ({
        ...peer,
        networkIds: [...peer.networkIds].sort(),
      }))
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    networks: [...input.networks]
      .map((network) => ({
        ...network,
        attachments: [...network.attachments].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function renderDeviceVpnStack(input: DeviceVpnStackInput) {
  const runtime = deviceVpnRuntimeConfig(input);
  const digest = deviceVpnStackDigest(input);
  const networkEntries = Object.fromEntries(
    input.networks.map((network) => [
      networkComposeAlias(network.id),
      { external: true, name: network.swarmNetworkName },
    ]),
  );
  const serviceNetworks = Object.fromEntries(
    input.networks.map((network) => [networkComposeAlias(network.id), {}]),
  );

  return stringify(
    {
      version: "3.9",
      services: {
        gateway: {
          image: input.image,
          user: "0",
          cap_add: ["NET_ADMIN", "NET_RAW"],
          command: [
            "node",
            "dist/src/networking/device-vpn-runtime.runner.js",
          ],
          environment: {
            RP_DEVICE_VPN_CONFIG_B64: Buffer.from(
              JSON.stringify(runtime),
              "utf8",
            ).toString("base64"),
          },
          secrets: [
            {
              source: "device_vpn_private_key",
              target: "device-vpn-private-key",
            },
            {
              source: "device_vpn_runtime_token",
              target: "device-vpn-runtime-token",
            },
          ],
          networks: serviceNetworks,
          ports: [
            {
              target: DEVICE_VPN_CONTAINER_PORT,
              published: input.publishedPort,
              protocol: "udp",
              mode: "ingress",
            },
          ],
          deploy: {
            replicas: 1,
            labels: {
              "resourceportal.device-vpn.gateway-id": input.gatewayId,
              "resourceportal.device-vpn.digest": digest,
            },
            placement: {
              constraints: ["node.labels.rp.node.control-plane == true"],
            },
            restart_policy: { condition: "any" },
          },
        },
      },
      networks: networkEntries,
      secrets: {
        device_vpn_private_key: {
          external: true,
          name: input.privateSecretName,
        },
        device_vpn_runtime_token: {
          external: true,
          name: input.runtimeTokenSecretName,
        },
      },
    },
    { lineWidth: 0 },
  );
}
