import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";

function entry(id: string, timestamp: Date) {
  return {
    id,
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantName: "tenant",
    timestamp,
    actor: "user-1",
    actorName: "User",
    action: "appgroup.update",
    resourceType: "AppGroup",
    resourceId: "55555555-5555-4555-8555-555555555555",
    resourceName: "app",
    result: "Success",
    errorCode: null,
    errorMessage: null,
    requestId: "req-1",
    correlationId: "66666666-6666-4666-8666-666666666666",
    ipAddress: null,
    userAgent: null,
    changes: null,
  };
}

describe("AuditService.listAuditLog", () => {
  it("applies tenant-scoped filters and returns a next cursor", async () => {
    const first = entry("22222222-2222-4222-8222-222222222222", new Date("2026-08-29T12:00:00Z"));
    const second = entry("33333333-3333-4333-8333-333333333333", new Date("2026-08-29T11:00:00Z"));
    const third = entry("44444444-4444-4444-8444-444444444444", new Date("2026-08-29T10:00:00Z"));
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: first.tenantId }),
      },
      auditLogEntry: {
        findMany: vi.fn().mockResolvedValue([first, second, third]),
      },
    };
    const service = new AuditService(prisma as unknown as PrismaService);

    const result = await service.listAuditLog(first.tenantId, {
      limit: 2,
      action: "appgroup.update",
      actor: "user-1",
      resourceType: "AppGroup",
      resourceId: first.resourceId,
      result: "Success",
      requestId: "req-1",
      correlationId: first.correlationId,
      from: "2026-08-29T00:00:00.000Z",
      to: "2026-08-30T00:00:00.000Z",
    });

    expect(result.items).toEqual([first, second]);
    expect(result.nextCursor).toBe(second.id);
    expect(prisma.auditLogEntry.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: first.tenantId,
        action: "appgroup.update",
        actor: "user-1",
        resourceType: "AppGroup",
        resourceId: first.resourceId,
        result: "Success",
        requestId: "req-1",
        correlationId: first.correlationId,
        timestamp: {
          gte: new Date("2026-08-29T00:00:00.000Z"),
          lte: new Date("2026-08-30T00:00:00.000Z"),
        },
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("uses cursor + skip for the next page", async () => {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: "tenant" }),
      },
      auditLogEntry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const service = new AuditService(prisma as unknown as PrismaService);
    const cursor = "22222222-2222-4222-8222-222222222222";

    await service.listAuditLog("11111111-1111-4111-8111-111111111111", {
      limit: 50,
      cursor,
    });

    expect(prisma.auditLogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: cursor },
        skip: 1,
        take: 51,
      }),
    );
  });

  it("rejects an inverted time range", async () => {
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: "tenant" }),
      },
      auditLogEntry: {
        findMany: vi.fn(),
      },
    };
    const service = new AuditService(prisma as unknown as PrismaService);

    await expect(
      service.listAuditLog("11111111-1111-4111-8111-111111111111", {
        limit: 50,
        from: "2026-08-30T00:00:00.000Z",
        to: "2026-08-29T00:00:00.000Z",
      }),
    ).rejects.toThrow("Audit log 'from' must not be after 'to'");
    expect(prisma.auditLogEntry.findMany).not.toHaveBeenCalled();
  });
});

describe("AuditService.exportAuditLog", () => {
  it("exports the complete filtered result set as JSON without list pagination", async () => {
    const auditEntry = entry(
      "22222222-2222-4222-8222-222222222222",
      new Date("2026-08-29T12:00:00Z"),
    );
    type FindManyInput = {
      where: Record<string, unknown>;
      orderBy: unknown;
      take?: number;
    };
    const findMany = vi.fn((input: FindManyInput) => {
      void input;
      return Promise.resolve([auditEntry]);
    });
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: auditEntry.tenantId }),
      },
      auditLogEntry: { findMany },
    };
    const service = new AuditService(prisma as unknown as PrismaService);

    const exported = await service.exportAuditLog(auditEntry.tenantId, {
      format: "json",
      resourceId: auditEntry.resourceId,
      correlationId: auditEntry.correlationId,
      requestId: auditEntry.requestId ?? undefined,
    });
    const parsedBody = JSON.parse(exported.body) as unknown;

    expect(exported.contentType).toBe("application/json; charset=utf-8");
    expect(exported.fileName).toBe(`audit-log-${auditEntry.tenantId}.json`);
    expect(parsedBody).toEqual([
      {
        ...auditEntry,
        timestamp: auditEntry.timestamp.toISOString(),
      },
    ]);
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      tenantId: auditEntry.tenantId,
      resourceId: auditEntry.resourceId,
      correlationId: auditEntry.correlationId,
      requestId: auditEntry.requestId,
    });
    expect(findMany.mock.calls[0]?.[0]?.take).toBeUndefined();
  });

  it("escapes CSV cells and serializes changes as JSON", async () => {
    const auditEntry = {
      ...entry(
        "22222222-2222-4222-8222-222222222222",
        new Date("2026-08-29T12:00:00Z"),
      ),
      resourceName: 'api, "primary"',
      changes: { before: "old", after: "new" },
    };
    const prisma = {
      tenant: {
        findUnique: vi.fn().mockResolvedValue({ id: auditEntry.tenantId }),
      },
      auditLogEntry: {
        findMany: vi.fn().mockResolvedValue([auditEntry]),
      },
    };
    const service = new AuditService(prisma as unknown as PrismaService);

    const exported = await service.exportAuditLog(auditEntry.tenantId, {
      format: "csv",
    });

    expect(exported.contentType).toBe("text/csv; charset=utf-8");
    expect(exported.fileName).toBe(`audit-log-${auditEntry.tenantId}.csv`);
    expect(exported.body).toContain("tenantId,tenantName,timestamp,actor,actorName,action");
    expect(exported.body).toContain('"api, ""primary"""');
    expect(exported.body).toContain('"{""before"":""old"",""after"":""new""}"');
  });
});
