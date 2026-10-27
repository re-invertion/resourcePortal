import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports only sanitized durable platform upgrade state across reloads", async () => {
    const op = { id: "123", type: "PLATFORM_RELEASE_UPDATE", status: "Running", phase: "applying", createdAt: new Date("2026-10-27T10:00:00Z"), completedAt: null, createdByEmail: "admin@example.test", input: { secret: "token" } };
    const findFirst = vi.fn().mockResolvedValue(op);
    const prisma = { operation: { findFirst } } as unknown as PrismaService;
    const controller = new HealthController(prisma);
    const progress = await controller.getUpgradeState();
    expect(progress).toMatchObject({ updating: true, status: "Running", phase: "applying" });
    expect(progress).not.toHaveProperty("createdByEmail");
    expect(progress).not.toHaveProperty("input");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { type: "PLATFORM_RELEASE_UPDATE", tenantId: null } }));
    findFirst.mockResolvedValueOnce({ ...op, status: "Succeeded", completedAt: new Date() });
    await expect(controller.getUpgradeState()).resolves.toMatchObject({ updating: false, status: "Succeeded", phase: null });
  });

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

  it("exposes the deployed ResourcePortal release version when configured", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const config = { get: vi.fn((key: string) => key === "RESOURCEPORTAL_VERSION" ? "0.2.26" : undefined) };
    const controller = new HealthController(prisma, undefined, config as never);

    expect(controller.getLiveness()).toMatchObject({
      service: "resource-portal-api",
      status: "ok",
      version: "0.2.26",
    });
    await expect(controller.getReadiness()).resolves.toMatchObject({ version: "0.2.26" });
  });
  it("does not confuse API liveness with completed automatic tenant SSO activation", async () => {
    const prisma = { $queryRaw: vi.fn() } as unknown as PrismaService;
    const rollout = { readiness: vi.fn().mockResolvedValue({ status: "pending" }) };
    const controller = new HealthController(prisma, undefined, undefined, rollout as never);
    await expect(controller.getTenantOidcReadiness()).rejects.toThrow();
    rollout.readiness.mockResolvedValue({ status: "ready" });
    await expect(controller.getTenantOidcReadiness()).resolves.toEqual({
      status: "ready", service: "resource-portal-tenant-oidc",
    });
  });

  it("returns an aggregate Worker health view without diagnostic payloads", async () => {
    const prisma = { $queryRaw: vi.fn() } as unknown as PrismaService;
    const workerObservability = {
      workerHealth: vi.fn().mockResolvedValue({
        status: "ok",
        service: "resource-portal-worker",
        workers: { total: 1, active: 1, stale: 0 },
        reconciliations: { failing: 0 },
      }),
    };
    const controller = new HealthController(prisma, workerObservability as never);

    await expect(controller.getWorkerHealth()).resolves.toEqual({
      status: "ok",
      service: "resource-portal-worker",
      workers: { total: 1, active: 1, stale: 0 },
      reconciliations: { failing: 0 },
    });
    expect(workerObservability.workerHealth).toHaveBeenCalledOnce();
  });

});
