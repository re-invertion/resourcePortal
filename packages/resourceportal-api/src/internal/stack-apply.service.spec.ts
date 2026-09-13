import { ConfigService } from "@nestjs/config";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { StackApplyService } from "./stack-apply.service";

function attach(renderedStack: string) {
  const service = new StackApplyService({ get: vi.fn() } as unknown as ConfigService);
  return (
    service as unknown as {
      attachIngressNetworks: (stack: string) => string;
    }
  ).attachIngressNetworks(renderedStack);
}

describe("StackApplyService managed ingress", () => {
  it("attaches Traefik-managed services to their external Swarm network", () => {
    const output = attach(`
version: "3.9"
services:
  web:
    image: nginx:alpine
    deploy:
      labels:
        traefik.enable: "true"
        traefik.swarm.network: resourceportal-control-plane_rp-ingress
`);
    const stack = parse(output) as {
      services: { web: { networks: string[] | Record<string, unknown> } };
      networks: Record<string, { external: boolean; name: string }>;
    };

    expect(stack.services.web.networks).toMatchObject({
      "resourceportal-control-plane_rp-ingress": {},
    });
    expect(stack.networks["resourceportal-control-plane_rp-ingress"]).toEqual({
      external: true,
      name: "resourceportal-control-plane_rp-ingress",
    });
  });

  it("leaves stacks without Traefik network labels unchanged", () => {
    const input = `version: "3.9"\nservices:\n  worker:\n    image: busybox\n`;
    expect(attach(input)).toBe(input);
  });
});
