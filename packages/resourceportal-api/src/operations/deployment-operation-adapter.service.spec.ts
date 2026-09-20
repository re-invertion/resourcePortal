import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import * as deploymentAdapter from "./deployment-operation-adapter.service";
import {
  deploymentOperationType,
  mirrorDeploymentOperation,
} from "./deployment-operation-adapter.service";

describe("v0.2 deployment Operation creation", () => {
  it("maps deploy and rollback into the common Operation types", () => {
    expect(deploymentOperationType({ rollbackTargetVersion: null })).toBe(
      "APP_GROUP_DEPLOY",
    );
    expect(deploymentOperationType({ rollbackTargetVersion: 3 })).toBe(
      "APP_GROUP_ROLLBACK",
    );
  });

  it("creates deployment execution ownership in the caller transaction", async () => {
    const queryRaw = vi
      .fn<(sql: Prisma.Sql) => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([
        { id: "11111111-1111-4111-8111-111111111111" },
      ]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    const result = await mirrorDeploymentOperation(
      tx,
      {
        id: "11111111-1111-4111-8111-111111111111",
        appGroupId: "22222222-2222-4222-8222-222222222222",
        version: 7,
        phase: "Validating",
        correlationId: "correlation-1",
        rollbackTargetVersion: null,
      },
      "33333333-3333-4333-8333-333333333333",
      {
        id: "44444444-4444-4444-8444-444444444444",
        email: "actor@example.com",
        displayName: "Actor",
      },
    );

    expect(result).toEqual({ id: "11111111-1111-4111-8111-111111111111" });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0]?.[0];
    expect(sql?.values).toContain("APP_GROUP_DEPLOY");
    expect(sql?.values).toContain("deployment:11111111-1111-4111-8111-111111111111");
    expect(sql?.strings.join(" ")).toContain("5, NOW()");
  });

  it("has no deployment-to-Operation state synchronization API", () => {
    expect("DeploymentOperationAdapterService" in deploymentAdapter).toBe(false);
    expect("mapDeploymentOperationStatus" in deploymentAdapter).toBe(false);
  });
});
