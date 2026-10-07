import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BugReportPriority, UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedUser } from "../auth/types";
import { BugReportsService } from "./bug-reports.service";

const actor: AuthenticatedUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "reporter@example.test",
  displayName: "Reporter",
  status: UserStatus.Active,
};

function prismaMock() {
  return {
    bugReport: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

describe("BugReportsService", () => {
  it("creates an Unassigned bug report for the authenticated user", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({
      id: "r1",
      priority: BugReportPriority.Unassigned,
      createdAt: new Date(),
    });
    const service = new BugReportsService(prisma as never);
    await service.create(
      { description: "  Deployment fails after clicking deploy.  ", url: " https://resource-portal.test/apps " },
      actor,
    );
    expect(prisma.bugReport.create).toHaveBeenCalledOnce();
    const [createArgs] = prisma.bugReport.create.mock.calls[0] as unknown as [
      { data: { description: string; priority: BugReportPriority; reportedById: string; url?: string | null } },
    ];
    expect(createArgs.data.description).toBe(
      "Deployment fails after clicking deploy.",
    );
    expect(createArgs.data.priority).toBe(BugReportPriority.Unassigned);
    expect(createArgs.data.reportedById).toBe(actor.id);
    expect(createArgs.data.url).toBe("https://resource-portal.test/apps");
  });

  it("creates Unassigned first and lets the AI classifier assign priority asynchronously", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({
      id: "r-critical",
      priority: BugReportPriority.Unassigned,
      createdAt: new Date(),
    });
    prisma.bugReport.updateMany.mockResolvedValue({ count: 1 });
    const resourceBot = {
      getRuntimeConfiguration: vi.fn().mockResolvedValue({
        apiKey: "configured",
        generationModel: "gpt-test",
        embeddingModel: "embed-test",
      }),
    };
    const openAi = {
      classifyBugReport: vi.fn().mockResolvedValue({
        priority: "P0",
        reason: "Platform-wide outage",
      }),
    };
    const service = new BugReportsService(
      prisma as never,
      resourceBot as never,
      openAi as never,
    );

    const created = await service.create(
      { description: "All tenants return 503" },
      actor,
    );

    expect(created.priority).toBe(BugReportPriority.Unassigned);
    const [createArgs] = prisma.bugReport.create.mock.calls[0] as unknown as [
      { data: { priority: BugReportPriority } },
    ];
    expect(createArgs.data.priority).toBe(BugReportPriority.Unassigned);
    await vi.waitFor(() =>
      expect(prisma.bugReport.updateMany).toHaveBeenCalledWith({
        where: {
          id: "r-critical",
          priority: BugReportPriority.Unassigned,
        },
        data: { priority: BugReportPriority.P0 },
      }),
    );
    expect(openAi.classifyBugReport).toHaveBeenCalledWith(
      expect.objectContaining({ generationModel: "gpt-test" }),
      "All tenants return 503",
    );
  });

  it("keeps the report Unassigned when automatic classification fails", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({
      id: "r-unassigned",
      priority: BugReportPriority.Unassigned,
      createdAt: new Date(),
    });
    const resourceBot = {
      getRuntimeConfiguration: vi.fn().mockRejectedValue(new Error("not configured")),
    };
    const openAi = { classifyBugReport: vi.fn() };
    const service = new BugReportsService(
      prisma as never,
      resourceBot as never,
      openAi as never,
    );

    const created = await service.create(
      { description: "Needs triage" },
      actor,
    );

    expect(created.priority).toBe(BugReportPriority.Unassigned);
    await Promise.resolve();
    await Promise.resolve();
    expect(prisma.bugReport.updateMany).not.toHaveBeenCalled();
  });

  it("accepts a valid PNG attachment and rejects spoofed image content", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({
      id: "r1",
      priority: BugReportPriority.P2,
      createdAt: new Date(),
    });
    const service = new BugReportsService(prisma as never);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("payload"),
    ]).toString("base64");
    await service.create(
      {
        description: "Screenshot included",
        imageData: png,
        imageMimeType: "image/png",
        imageFileName: "shot.png",
      },
      actor,
    );
    const [createArgs] = prisma.bugReport.create.mock.calls[0] as unknown as [
      { data: { imageMimeType?: string } },
    ];
    expect(createArgs.data.imageMimeType).toBe("image/png");
    await expect(
      service.create(
        {
          description: "Spoofed file",
          imageData: Buffer.from("not-a-png").toString("base64"),
          imageMimeType: "image/png",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps admin list records to safe image URLs", async () => {
    const prisma = prismaMock();
    prisma.bugReport.findMany.mockResolvedValue([
      {
        id: "22222222-2222-4222-8222-222222222222",
        description: "Broken screen",
        priority: BugReportPriority.P0,
        reportedBy: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
        },
        imageData: Buffer.from("image"),
        imageMimeType: "image/png",
        imageFileName: "shot.png",
        url: "https://resource-portal.test/apps",
        resolutionNote: "Moved networking to the Single App editor.",
        resolvedAt: new Date("2026-09-28T13:00:00Z"),
        createdAt: new Date("2026-09-28T12:00:00Z"),
        updatedAt: new Date("2026-09-28T12:00:00Z"),
      },
    ]);
    const service = new BugReportsService(prisma as never);
    const result = await service.list();
    expect(result[0]).toMatchObject({
      priority: BugReportPriority.P0,
      resolved: true,
      resolvedAt: new Date("2026-09-28T13:00:00Z"),
      hasImage: true,
      imageUrl:
        "/api/platform/bug-reports/22222222-2222-4222-8222-222222222222/image",
      url: "https://resource-portal.test/apps",
      resolutionNote: "Moved networking to the Single App editor.",
    });
  });

  it("marks a bug report as resolved and can reopen it", async () => {
    const prisma = prismaMock();
    prisma.bugReport.findUnique.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
    });
    prisma.bugReport.update
      .mockResolvedValueOnce({
        id: "44444444-4444-4444-8444-444444444444",
        description: "Broken screen",
        priority: BugReportPriority.P2,
        resolvedAt: new Date("2026-09-28T19:30:00Z"),
        reportedBy: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
        },
        imageData: null,
        imageMimeType: null,
        imageFileName: null,
        url: null,
        resolutionNote: "Implemented the fix.",
        createdAt: new Date("2026-09-28T12:00:00Z"),
        updatedAt: new Date("2026-09-28T19:30:00Z"),
      })
      .mockResolvedValueOnce({
        id: "44444444-4444-4444-8444-444444444444",
        description: "Broken screen",
        priority: BugReportPriority.P2,
        resolvedAt: null,
        reportedBy: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
        },
        imageData: null,
        imageMimeType: null,
        imageFileName: null,
        url: null,
        resolutionNote: null,
        createdAt: new Date("2026-09-28T12:00:00Z"),
        updatedAt: new Date("2026-09-28T19:31:00Z"),
      });
    const service = new BugReportsService(prisma as never);

    const resolved = await service.setResolved(
      "44444444-4444-4444-8444-444444444444",
      true,
      "  Implemented the fix.  ",
    );
    expect(resolved.resolved).toBe(true);
    const resolvedUpdate = prisma.bugReport.update.mock
      .calls[0]?.[0] as unknown as {
      data: { resolvedAt: Date | null; resolutionNote: string | null };
    };
    expect(resolvedUpdate.data.resolvedAt).toBeInstanceOf(Date);
    expect(resolvedUpdate.data.resolutionNote).toBe("Implemented the fix.");

    const reopened = await service.setResolved(
      "44444444-4444-4444-8444-444444444444",
      false,
    );
    expect(reopened.resolved).toBe(false);
    const reopenedUpdate = prisma.bugReport.update.mock
      .calls[1]?.[0] as unknown as {
      data: { resolvedAt: Date | null; resolutionNote: string | null };
    };
    expect(reopenedUpdate.data.resolvedAt).toBeNull();
    expect(reopenedUpdate.data.resolutionNote).toBeNull();
  });

  it("returns 404 when updating a missing report", async () => {
    const prisma = prismaMock();
    prisma.bugReport.findUnique.mockResolvedValue(null);
    const service = new BugReportsService(prisma as never);
    await expect(
      service.setPriority(
        "33333333-3333-4333-8333-333333333333",
        BugReportPriority.P1,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.setResolved("33333333-3333-4333-8333-333333333333", true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});