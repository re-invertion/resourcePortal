import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("returns liveness without checking dependencies", () => {
    const queryRaw = vi.fn();
    const prisma = {
      $queryRaw: queryRaw,
    } as unknown as PrismaService;
    const controller = new HealthController(prisma);

    expect(controller.getLiveness()).toEqual({
      service: "resource-portal-api",
      status: "ok",
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("checks postgres readiness", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const prisma = {
      $queryRaw: queryRaw,
    } as unknown as PrismaService;
    const controller = new HealthController(prisma);

    await expect(controller.getReadiness()).resolves.toEqual({
      dependencies: {
        postgres: "ok",
      },
      service: "resource-portal-api",
      status: "ok",
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});
