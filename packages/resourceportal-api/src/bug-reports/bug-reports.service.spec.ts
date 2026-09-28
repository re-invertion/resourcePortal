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
    },
  };
}

describe("BugReportsService", () => {
  it("creates a P2 bug report for the authenticated user", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({ id: "r1", priority: BugReportPriority.P2, createdAt: new Date() });
    const service = new BugReportsService(prisma as never);
    await service.create({ description: "  Deployment fails after clicking deploy.  " }, actor);
    expect(prisma.bugReport.create).toHaveBeenCalledOnce();
    const [createArgs] = prisma.bugReport.create.mock.calls[0] as unknown as [{ data: { description: string; reportedById: string } }];
    expect(createArgs.data.description).toBe("Deployment fails after clicking deploy.");
    expect(createArgs.data.reportedById).toBe(actor.id);
  });

  it("accepts a valid PNG attachment and rejects spoofed image content", async () => {
    const prisma = prismaMock();
    prisma.bugReport.create.mockResolvedValue({ id: "r1", priority: BugReportPriority.P2, createdAt: new Date() });
    const service = new BugReportsService(prisma as never);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("payload")]).toString("base64");
    await service.create({ description: "Screenshot included", imageData: png, imageMimeType: "image/png", imageFileName: "shot.png" }, actor);
    const [createArgs] = prisma.bugReport.create.mock.calls[0] as unknown as [{ data: { imageMimeType?: string } }];
    expect(createArgs.data.imageMimeType).toBe("image/png");
    await expect(service.create({ description: "Spoofed file", imageData: Buffer.from("not-a-png").toString("base64"), imageMimeType: "image/png" }, actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps admin list records to safe image URLs", async () => {
    const prisma = prismaMock();
    prisma.bugReport.findMany.mockResolvedValue([{
      id: "22222222-2222-4222-8222-222222222222",
      description: "Broken screen",
      priority: BugReportPriority.P0,
      reportedBy: { id: actor.id, email: actor.email, displayName: actor.displayName },
      imageData: Buffer.from("image"),
      imageMimeType: "image/png",
      imageFileName: "shot.png",
      createdAt: new Date("2026-09-28T12:00:00Z"),
      updatedAt: new Date("2026-09-28T12:00:00Z"),
    }]);
    const service = new BugReportsService(prisma as never);
    const result = await service.list();
    expect(result[0]).toMatchObject({ priority: BugReportPriority.P0, hasImage: true, imageUrl: "/api/platform/bug-reports/22222222-2222-4222-8222-222222222222/image" });
  });

  it("returns 404 when updating a missing report", async () => {
    const prisma = prismaMock();
    prisma.bugReport.findUnique.mockResolvedValue(null);
    const service = new BugReportsService(prisma as never);
    await expect(service.setPriority("33333333-3333-4333-8333-333333333333", BugReportPriority.P1)).rejects.toBeInstanceOf(NotFoundException);
  });
});
