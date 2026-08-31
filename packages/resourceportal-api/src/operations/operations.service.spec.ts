import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UserStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import type { OperationRecord } from "./operation.types";

const implementationUrl = new URL("./operations.service.ts", import.meta.url);
const modulePath = `./${["operations"].join("-")}.service`;

const actor: AuthenticatedUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "actor@example.com",
  displayName: "Actor",
  status: UserStatus.Active,
};

const operation = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "Pending",
} as OperationRecord;

describe("Stage 16 OperationsService", () => {
  it("snapshots the actor while enqueueing an operation", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      OperationsService: new (repository: unknown) => {
        enqueue: (input: unknown) => Promise<OperationRecord>;
      };
    };
    const createOperation = vi.fn().mockResolvedValue(operation);
    const service = new imported.OperationsService({ createOperation });

    await service.enqueue({
      type: "DOMAIN_VERIFY",
      tenantId: "22222222-2222-4222-8222-222222222222",
      resourceType: "Domain",
      resourceId: "33333333-3333-4333-8333-333333333333",
      actor,
      input: {},
      idempotencyKey: "verify-1",
    });

    expect(createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: actor.id,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        idempotencyKey: "verify-1",
      }),
    );
  });

  it("rejects manual retry for AppGroup deployment mirror operations", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const imported = (await import(modulePath)) as unknown as {
      OperationsService: new (repository: unknown) => {
        retry: (tenantId: string, operationId: string) => Promise<OperationRecord>;
      };
    };
    const deploymentMirror = {
      ...operation,
      type: "APP_GROUP_DEPLOY",
      status: "Failed",
      tenantId: "22222222-2222-4222-8222-222222222222",
    } as OperationRecord;
    const retryFailedOperation = vi.fn();
    const service = new imported.OperationsService({
      getOperation: vi.fn().mockResolvedValue(deploymentMirror),
      retryFailedOperation,
    });

    await expect(
      service.retry(deploymentMirror.tenantId!, deploymentMirror.id),
    ).rejects.toMatchObject({
      response: "OperationNotRetryable",
    });
    expect(retryFailedOperation).not.toHaveBeenCalled();
  });
});
