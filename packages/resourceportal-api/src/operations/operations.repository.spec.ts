import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service";

const implementationUrl = new URL("./operations.repository.ts", import.meta.url);
const modulePath = `./${["operations", "repository"].join(".")}`;

type OperationRow = {
  id: string;
  type: string;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  status: string;
  phase: string | null;
  createdBy: string;
  createdByEmail: string;
  createdByDisplayName: string;
  input: unknown;
  result: unknown;
  idempotencyKey: string | null;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};

type CreateInput = {
  type: string;
  tenantId: string | null;
  resourceType: string;
  resourceId: string | null;
  createdBy: string;
  createdByEmail: string;
  createdByDisplayName: string;
  input: unknown;
  idempotencyKey?: string;
};

type RepositoryLike = {
  createOperation: (input: CreateInput) => Promise<OperationRow>;
  claimNext: (workerId: string, leaseSeconds: number) => Promise<OperationRow | null>;
};

type RepositoryModule = {
  OperationsRepository: new (prisma: PrismaService) => RepositoryLike;
};

async function loadRepositoryModule() {
  const imported = (await import(modulePath)) as unknown;
  return imported as RepositoryModule;
}

const operationRow: OperationRow = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "DOMAIN_VERIFY",
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceType: "Domain",
  resourceId: "33333333-3333-4333-8333-333333333333",
  status: "Pending",
  phase: null,
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdByEmail: "actor@example.com",
  createdByDisplayName: "Actor",
  input: {},
  result: null,
  idempotencyKey: null,
  attempt: 0,
  maxAttempts: 5,
  nextAttemptAt: new Date("2026-08-31T12:00:00Z"),
  leaseOwner: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-08-31T12:00:00Z"),
  startedAt: null,
  completedAt: null,
};

describe("Stage 16 OperationsRepository", () => {
  it("returns the idempotent existing operation when create resolves the same key", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationsRepository } = await loadRepositoryModule();

    const queryRaw = vi.fn().mockResolvedValue([operationRow]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const repository = new OperationsRepository(prisma);

    const result = await repository.createOperation({
      type: "DOMAIN_VERIFY",
      tenantId: operationRow.tenantId,
      resourceType: "Domain",
      resourceId: operationRow.resourceId,
      createdBy: operationRow.createdBy,
      createdByEmail: operationRow.createdByEmail,
      createdByDisplayName: operationRow.createdByDisplayName,
      input: {},
      idempotencyKey: "same-request",
    });

    expect(result.id).toBe(operationRow.id);
    expect(result.status).toBe("Pending");
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("re-reads the existing operation when a concurrent idempotent insert loses the conflict race", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationsRepository } = await loadRepositoryModule();

    const concurrentWinner: OperationRow = {
      ...operationRow,
      idempotencyKey: "same-request",
    };
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([concurrentWinner]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const repository = new OperationsRepository(prisma);

    const result = await repository.createOperation({
      type: "DOMAIN_VERIFY",
      tenantId: operationRow.tenantId,
      resourceType: "Domain",
      resourceId: operationRow.resourceId,
      createdBy: operationRow.createdBy,
      createdByEmail: operationRow.createdByEmail,
      createdByDisplayName: operationRow.createdByDisplayName,
      input: {},
      idempotencyKey: "same-request",
    });

    expect(result.id).toBe(concurrentWinner.id);
    expect(result.idempotencyKey).toBe("same-request");
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("claims only an eligible queued operation and returns its Running state", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationsRepository } = await loadRepositoryModule();

    const claimed: OperationRow = {
      ...operationRow,
      status: "Running",
      attempt: 1,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date("2026-08-31T12:05:00Z"),
      heartbeatAt: new Date("2026-08-31T12:00:00Z"),
      startedAt: new Date("2026-08-31T12:00:00Z"),
    };
    const queryRaw = vi.fn().mockResolvedValue([claimed]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const repository = new OperationsRepository(prisma);

    const result = await repository.claimNext("worker-a", 300);

    expect(result?.status).toBe("Running");
    expect(result?.attempt).toBe(1);
    expect(result?.leaseOwner).toBe("worker-a");
  });
});
