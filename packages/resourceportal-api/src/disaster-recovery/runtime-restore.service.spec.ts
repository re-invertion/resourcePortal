import { DeploymentStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { StackApplyService } from "../internal/stack-apply.service";
import { RuntimeRestoreService } from "./runtime-restore.service";

describe("RuntimeRestoreService", () => {
  it("re-applies the current successful rendered stack for each deployed AppGroup", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "app-group-1",
        currentDeploymentVersion: 4,
        deployments: [
          {
            id: "deployment-4",
            version: 4,
            status: DeploymentStatus.Succeeded,
            renderedStack: "services:\n  web:\n    image: example/web:4\n",
          },
        ],
      },
    ]);
    const applyStack = vi.fn().mockResolvedValue({
      stackName: "rp_app_group_1",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const service = new RuntimeRestoreService(
      { appGroup: { findMany } } as unknown as PrismaService,
      { applyStack } as unknown as StackApplyService,
    );

    await expect(service.reconcile()).resolves.toEqual({
      checked: 1,
      applied: 1,
      failed: 0,
      skipped: 0,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { currentDeploymentVersion: { not: null } },
      }),
    );
    expect(applyStack).toHaveBeenCalledWith({
      stackName: "rp_app_group_1",
      renderedStack: "services:\n  web:\n    image: example/web:4\n",
    });
  });

  it("reports missing rendered stacks and failed docker applies", async () => {
    const applyStack = vi.fn().mockResolvedValue({
      stackName: "rp_app_group_2",
      exitCode: 1,
      stdout: "",
      stderr: "apply failed",
    });
    const service = new RuntimeRestoreService(
      {
        appGroup: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "app-group-1",
              currentDeploymentVersion: 1,
              deployments: [{ version: 1, renderedStack: null }],
            },
            {
              id: "app-group-2",
              currentDeploymentVersion: 2,
              deployments: [{ version: 2, renderedStack: "services: {}\n" }],
            },
          ]),
        },
      } as unknown as PrismaService,
      { applyStack } as unknown as StackApplyService,
    );

    await expect(service.reconcile()).resolves.toEqual({
      checked: 2,
      applied: 0,
      failed: 1,
      skipped: 1,
    });
  });
});
