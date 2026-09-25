/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  GATE_CONTAINER_PORT,
  gateRuntimeConfig,
  gateStackDigest,
  renderGateStack,
} from "./gate-stack";

const input = {
  gateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  image: "ghcr.io/re-invertion/resourceportal-api:test",
  publishedPort: 52042,
  serverTunnelAddress: "10.253.0.1/30",
  clientTunnelAddress: "10.253.0.2/30",
  peerPublicKey: "peer-public-key",
  peerLanCidrs: ["192.168.50.0/24"],
  privateSecretName: "rp-gate-private-v1",
  networks: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      swarmNetworkName: "rp-network-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      overlayCidr: "10.200.12.0/24",
      attachments: [
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          address: "10.240.12.10",
        },
      ],
    },
  ],
};

describe("ResourcePortalGate stack rendering", () => {
  it("publishes one UDP WireGuard endpoint and attaches only selected RP Networks", () => {
    const stack = parse(renderGateStack(input)) as any;
    expect(stack.services.gateway.ports).toEqual([
      {
        target: GATE_CONTAINER_PORT,
        published: 52042,
        protocol: "udp",
        mode: "ingress",
      },
    ]);
    expect(stack.services.gateway.cap_add).toEqual(["NET_ADMIN", "NET_RAW"]);
    expect(Object.keys(stack.networks)).toEqual([
      "rpnet_bbbbbbbb_bbbb_4bbb_8bbb_bbbbbbbbbbbb",
    ]);
    expect(stack.networks.rpnet_bbbbbbbb_bbbb_4bbb_8bbb_bbbbbbbbbbbb).toEqual({
      external: true,
      name: "rp-network-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(stack.services.gateway).not.toHaveProperty("volumes");
  });

  it("produces a deterministic desired-state digest", () => {
    const reversed = {
      ...input,
      peerLanCidrs: [...input.peerLanCidrs].reverse(),
      networks: input.networks.map((network) => ({
        ...network,
        attachments: [...network.attachments].reverse(),
      })),
    };
    expect(gateStackDigest(reversed)).toBe(gateStackDigest(input));
  });

  it("maps stable VPN addresses through internal attachment aliases without exposing DNS config", () => {
    const runtime = gateRuntimeConfig(input);
    expect(runtime.mappings).toEqual([
      {
        stableAddress: "10.240.12.10",
        overlayCidr: "10.200.12.0/24",
        attachmentAlias: "rp-att-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    ]);
    const rendered = renderGateStack(input);
    expect(rendered).not.toMatch(/dns:|hostname:|serviceDiscovery/i);
  });
});