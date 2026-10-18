import { readFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { AppLanRouteReconcilerService } from "./app-lan-route-reconciler.service";

class Harness extends AppLanRouteReconcilerService {
  readonly commands: string[][] = [];
  protected override docker(args: string[]) {
    this.commands.push(args);
    return args[0] === "service" && args[1] === "inspect" ? "[]" : "";
  }
}
function fixture(stack: string) {
  const prisma = { resourcePortalGate: { findMany: () => Promise.resolve([]) } } as unknown as PrismaService;
  const config = { get: (key: string, fallback?: string) =>
    key === "RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME" ? stack : fallback,
  } as unknown as ConfigService;
  return new Harness(prisma, config);
}

describe("application route worker for custom-named control plane", () => {
  it("targets the actual configured Swarm stack, not the hardcoded default", async () => {
    const runner = fixture("rp-custom-stack");
    await expect(runner.reconcile()).resolves.toEqual({ changed: true, routes: 0 });
    expect(runner.commands[0]).toEqual([
      "service", "inspect", "rp-custom-stack_app-lan-router",
      "--format", "{{json .Spec.TaskTemplate.ContainerSpec.Env}}",
    ]);
    expect(runner.commands[1]?.slice(-1)[0]).toBe("rp-custom-stack_app-lan-router");
    const tpl = readFileSync(new URL("../../../../config/production/stack.yml.tpl", import.meta.url), "utf8");
    const renderer = readFileSync(new URL("../../../../scripts/installer/control-plane.sh", import.meta.url), "utf8");
    expect(tpl).toContain("RESOURCEPORTAL_CONTROL_PLANE_STACK_NAME: __STACK_NAME__");
    expect(renderer).toContain('"STACK_NAME|${RP_CFG_STACK_NAME:-resourceportal-control-plane}"');
  });
  it("fails closed on invalid stack names", async () => {
    const runner = fixture("../escape");
    await expect(runner.reconcile()).rejects.toThrow("Invalid RP control-plane Swarm stack name");
    expect(runner.commands).toHaveLength(0);
  });
});

describe("stale saved application LAN grants", () => {
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const gate = (policies: unknown) => ({
    id: "gate-1",
    tenantId: "tenant-1",
    agentVersion: "gate-shell-v3",
    lanCidrs: ["192.168.50.0/24"],
    applicationLanPolicies: policies,
    networks: [{
      id: "link-1",
      network: {
        id: "network-1",
        swarmNetworkName: "test-overlay",
        overlayCidr: "10.200.0.0/24",
        attachments: [{
          id: attachmentId,
          singleAppId: "app-1",
          singleApp: { appGroupId: "group-1", name: "app-1" },
        }],
      },
    }],
  });
  const run = async (policies: unknown) => {
    const prisma = { resourcePortalGate: { findMany: () => Promise.resolve([gate(policies)]) } } as unknown as PrismaService;
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    const worker = new Harness(prisma, config);
    const result = await worker.reconcile();
    const update = worker.commands.find(command => command[0] === "service" && command[1] === "update");
    const env = update?.find(item => item.startsWith("RESOURCEPORTAL_APP_LAN_ROUTES_B64="));
    const policy = env ? JSON.parse(Buffer.from(env.split("=")[1], "base64").toString("utf8")) : null;
    return { result, policy, worker };
  };

  it("revokes deleted attachment rules rather than retaining old routes", async () => {
    const { result, policy } = await run([{
      attachmentId: "22222222-2222-4222-8222-222222222222",
      destinationCidr: "192.168.50.10/32", protocol: "tcp", port: 8090,
    }]);
    expect(result).toEqual({ changed: true, routes: 0 });
    expect(policy).toEqual({ version: 1, routes: [] });
  });

  it("revokes removed LAN destinations rather than blocking reconciliation", async () => {
    const { result, policy } = await run([{
      attachmentId, destinationCidr: "192.168.60.10/32", protocol: "tcp", port: 8090,
    }]);
    expect(result).toEqual({ changed: true, routes: 0 });
    expect(policy).toEqual({ version: 1, routes: [] });
  });

  it("fails closed for malformed saved grants and still publishes empty policy", async () => {
    const { result, policy } = await run([{
      attachmentId, destinationCidr: "not-a-cidr", protocol: "tcp", port: 8090,
    }]);
    expect(result).toEqual({ changed: true, routes: 0 });
    expect(policy).toEqual({ version: 1, routes: [] });
  });
});
