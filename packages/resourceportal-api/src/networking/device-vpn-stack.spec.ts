/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion */
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  DEVICE_VPN_CONTAINER_PORT,
  deviceVpnRuntimeConfig,
  deviceVpnStackDigest,
  renderDeviceVpnStack,
} from "./device-vpn-stack";

const input = {
  gatewayId: "primary",
  image: "ghcr.io/re-invertion/resourceportal-api:test",
  publishedPort: 51820,
  serverTunnelAddress: "100.64.0.1/11",
  privateSecretName: "rp-device-vpn-private-key-v1",
  runtimeTokenSecretName: "rp-device-vpn-runtime-token-v1",
  heartbeatUrl: "https://rp.example/api/networking/device-vpn/runtime/heartbeat",
  peers: [
    {
      deviceId: "device-b",
      publicKey: "peer-b",
      assignedAddress: "100.64.0.3",
      networkIds: ["network-b"],
    },
    {
      deviceId: "device-a",
      publicKey: "peer-a",
      assignedAddress: "100.64.0.2",
      networkIds: ["network-a"],
    },
  ],
  networks: [
    {
      id: "network-a",
      swarmNetworkName: "rp-network-a",
      overlayCidr: "10.200.10.0/24",
      attachments: [{ id: "attachment-a", address: "10.240.10.10" }],
    },
    {
      id: "network-b",
      swarmNetworkName: "rp-network-b",
      overlayCidr: "10.200.20.0/24",
      attachments: [{ id: "attachment-b", address: "10.240.20.10" }],
    },
  ],
};

describe("Device VPN stack rendering", () => {
  it("publishes one shared UDP endpoint for every device peer", () => {
    const stack = parse(renderDeviceVpnStack(input)) as any;
    expect(stack.services.gateway.ports).toEqual([
      {
        target: DEVICE_VPN_CONTAINER_PORT,
        published: 51820,
        protocol: "udp",
        mode: "ingress",
      },
    ]);
    expect(stack.services.gateway.secrets).toHaveLength(2);
    expect(Object.keys(stack.networks).sort()).toEqual([
      "rpnet_network_a",
      "rpnet_network_b",
    ]);
  });

  it("keeps peer authorization scoped to Network IDs in runtime config", () => {
    const runtime = deviceVpnRuntimeConfig(input);
    expect(runtime.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "device-a",
          assignedAddress: "100.64.0.2",
          networkIds: ["network-a"],
        }),
        expect.objectContaining({
          deviceId: "device-b",
          assignedAddress: "100.64.0.3",
          networkIds: ["network-b"],
        }),
      ]),
    );
    expect(runtime.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          networkId: "network-a",
          stableAddress: "10.240.10.10",
        }),
        expect.objectContaining({
          networkId: "network-b",
          stableAddress: "10.240.20.10",
        }),
      ]),
    );
  });

  it("produces a deterministic digest independent of peer ordering", () => {
    const reversed = {
      ...input,
      peers: [...input.peers].reverse(),
      networks: [...input.networks].reverse(),
    };
    expect(deviceVpnStackDigest(reversed)).toBe(deviceVpnStackDigest(input));
  });
});
