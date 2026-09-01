import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedUser } from "../auth/types";
import { PlatformMaintenanceAuditService } from "./platform-maintenance-audit.service";
import { PlatformMaintenanceService } from "./platform-maintenance.service";
import { PlatformMaintenanceStore } from "./platform-maintenance.store";

const actorId = "00000000-0000-4000-8000-000000000001";

describe("PlatformMaintenanceService", () => {
  it("returns persisted singleton state", async () => {
    const getState = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000019",
      enabled: true,
      reason: "database maintenance",
      updatedBy: actorId,
      updatedAt: new Date("2026-09-01T06:00:00.000Z"),
    });
    const store = { getState } as unknown as PlatformMaintenanceStore;
    const audit = {} as unknown as PlatformMaintenanceAuditService;
    const service = new PlatformMaintenanceService(store, audit);

    await expect(service.getState()).resolves.toEqual({
      enabled: true,
      reason: "database maintenance",
      updatedBy: actorId,
      updatedAt: new Date("2026-09-01T06:00:00.000Z"),
    });
  });

  it("persists changes and records a platform audit event", async () => {
    const updatedAt = new Date("2026-09-01T06:05:00.000Z");
    const setState = vi.fn().mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000019",
      enabled: true,
      reason: "storage intervention",
      updatedBy: actorId,
      updatedAt,
    });
    const recordChanged = vi.fn().mockResolvedValue(undefined);
    const store = { setState } as unknown as PlatformMaintenanceStore;
    const audit = { recordChanged } as unknown as PlatformMaintenanceAuditService;
    const service = new PlatformMaintenanceService(store, audit);
    const actor: AuthenticatedUser = {
      id: actorId,
      email: "admin@example.test",
      displayName: "Platform Admin",
      status: UserStatus.Active,
    };

    await expect(
      service.setState(true, "storage intervention", actor),
    ).resolves.toEqual({
      enabled: true,
      reason: "storage intervention",
      updatedBy: actorId,
      updatedAt,
    });
    expect(setState).toHaveBeenCalledWith({
      enabled: true,
      reason: "storage intervention",
      updatedBy: actorId,
    });
    expect(recordChanged).toHaveBeenCalledWith({
      enabled: true,
      reason: "storage intervention",
      actor,
    });
  });
});
