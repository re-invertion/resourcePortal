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
