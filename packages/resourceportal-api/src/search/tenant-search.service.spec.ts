import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { TenantSearchService } from "./tenant-search.service";

function fixture() {
  const prisma = {
    appGroup: { findMany: vi.fn().mockResolvedValue([]) },
    singleApp: { findMany: vi.fn().mockResolvedValue([]) },
    volume: { findMany: vi.fn().mockResolvedValue([]) },
    registry: { findMany: vi.fn().mockResolvedValue([]) },
    domain: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    prisma,
    service: new TenantSearchService(prisma as unknown as PrismaService),
  };
}

describe("TenantSearchService", () => {
  it("searches applications tenant-wide without an App Group count cap", async () => {
    const { prisma, service } = fixture();
    prisma.singleApp.findMany.mockResolvedValue([
      {
        id: "app-31",
        name: "checkout-api",
        description: "Checkout",
        image: "ghcr.io/acme/checkout:1",
        runtimeState: "Running",
        health: "Healthy",
        appGroup: { id: "group-31", name: "group thirty one" },
      },
    ]);

    const result = await service.search({
      tenantId: "tenant-1",
      query: "checkout",
      limit: 20,
      permissions: ["singleapp.read"],
    });

    expect(prisma.singleApp.findMany).toHaveBeenCalledOnce();
    const appSearch = prisma.singleApp.findMany.mock.calls[0]?.[0] as unknown as {
      where: { appGroup: { tenantId: string } };
    };
    expect(appSearch.where.appGroup).toEqual({ tenantId: "tenant-1" });
    expect(prisma.appGroup.findMany).not.toHaveBeenCalled();
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "application",
        id: "app-31",
        appGroupId: "group-31",
        label: "checkout-api",
      }),
    ]);
  });

  it("queries only resource kinds the tenant context can read", async () => {
    const { prisma, service } = fixture();
    prisma.volume.findMany.mockResolvedValue([
      {
        id: "volume-1",
        name: "orders-data",
        description: null,
        status: "Ready",
      },
    ]);

    const result = await service.search({
      tenantId: "tenant-1",
      query: "orders",
      permissions: ["volume.read"],
    });

    expect(prisma.volume.findMany).toHaveBeenCalledOnce();
    expect(prisma.appGroup.findMany).not.toHaveBeenCalled();
    expect(prisma.singleApp.findMany).not.toHaveBeenCalled();
    expect(prisma.registry.findMany).not.toHaveBeenCalled();
    expect(prisma.domain.findMany).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ kind: "volume", id: "volume-1" });
  });

  it("does not fan out for a query shorter than two characters", async () => {
    const { prisma, service } = fixture();
    const result = await service.search({
      tenantId: "tenant-1",
      query: "a",
      permissions: ["*"],
    });

    expect(result).toEqual({ items: [] });
    for (const model of Object.values(prisma)) {
      expect(model.findMany).not.toHaveBeenCalled();
    }
  });

  it("ranks exact labels first and enforces the requested result limit", async () => {
    const { prisma, service } = fixture();
    prisma.appGroup.findMany.mockResolvedValue([
      {
        id: "exact",
        name: "orders",
        description: null,
        runtimeState: "Running",
        health: "Healthy",
      },
      {
        id: "prefix",
        name: "orders-worker",
        description: null,
        runtimeState: "Running",
        health: "Healthy",
      },
    ]);

    const result = await service.search({
      tenantId: "tenant-1",
      query: "orders",
      limit: 1,
      permissions: ["appgroup.read"],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("exact");
  });
});
