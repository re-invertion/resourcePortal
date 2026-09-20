import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  AppendOperationEventInput,
  OperationExecutionResult,
  OperationRecord,
  OperationType,
} from "./operation.types";

const implementationUrl = new URL("./operations-worker.service.ts", import.meta.url);
const modulePath = `./${["operations", "worker"].join("-")}.service`;

type RepositoryLike = {
  failExhaustedOperations: () => Promise<OperationRecord[]>;
  claimNext: (workerId: string, leaseSeconds: number) => Promise<OperationRecord | null>;
  appendEvent: (
    operationId: string,
    input: AppendOperationEventInput,
  ) => Promise<unknown>;
  heartbeat: (
    operationId: string,
    workerId: string,
    leaseSeconds: number,
  ) => Promise<OperationRecord | null>;
  markSucceeded: (
    operationId: string,
    workerId: string,
    result: unknown,
    resourceId?: string | null,
    status?: "Succeeded" | "RolledBack",
  ) => Promise<OperationRecord | null>;
  markFailed: (
    operationId: string,
    workerId: string,
    code: string,
    message: string,
  ) => Promise<OperationRecord | null>;
  scheduleRetry: (
    operationId: string,
    workerId: string,
    nextAttemptAt: Date,
    code: string,
    message: string,
  ) => Promise<OperationRecord | null>;
};

type Executor = {
  types: readonly OperationType[];
  execute: (operation: OperationRecord) => Promise<OperationExecutionResult>;
};

type RegistryLike = {
  resolve: (type: OperationType) => Executor;
};

type WorkerLike = {
  processNext: (
    workerId: string,
    leaseSeconds: number,
  ) => Promise<OperationRecord | null>;
};

type WorkerModule = {
  OperationsWorkerService: new (
    repository: RepositoryLike,
    registry: RegistryLike,
  ) => WorkerLike;
};

async function loadWorkerModule() {
  const imported = (await import(modulePath)) as unknown;
  return imported as WorkerModule;
}

const operation: OperationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "DOMAIN_VERIFY",
  tenantId: "22222222-2222-4222-8222-222222222222",
  resourceType: "Domain",
  resourceId: "33333333-3333-4333-8333-333333333333",
  status: "Running",
  phase: null,
  createdBy: "44444444-4444-4444-8444-444444444444",
  createdByEmail: "actor@example.com",
  createdByDisplayName: "Actor",
  input: {},
  result: null,
  idempotencyKey: null,
  attempt: 1,
  maxAttempts: 5,
  nextAttemptAt: new Date("2026-08-31T12:00:00Z"),
  leaseOwner: "worker-a",
  leaseExpiresAt: new Date("2026-08-31T12:05:00Z"),
  heartbeatAt: new Date("2026-08-31T12:00:00Z"),
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-08-31T12:00:00Z"),
  startedAt: new Date("2026-08-31T12:00:00Z"),
  completedAt: null,
};

function repository(overrides: Partial<RepositoryLike> = {}) {
  return {
    failExhaustedOperations: vi.fn().mockResolvedValue([]),
    claimNext: vi.fn().mockResolvedValue(operation),
    appendEvent: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(operation),
    markSucceeded: vi.fn().mockResolvedValue({
      ...operation,
      status: "Succeeded",
      completedAt: new Date(),
    }),
    markFailed: vi.fn().mockResolvedValue({
      ...operation,
      status: "Failed",
      completedAt: new Date(),
    }),
    scheduleRetry: vi.fn().mockResolvedValue({
      ...operation,
      status: "Pending",
    }),
    ...overrides,
  } satisfies RepositoryLike;
}

describe("v0.2 OperationsWorkerService", () => {
  it("dispatches a claimed operation and commits success through lease ownership", async () => {
    expect(existsSync(fileURLToPath(implementationUrl))).toBe(true);
    const { OperationsWorkerService } = await loadWorkerModule();
    const repo = repository();
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute: vi.fn().mockResolvedValue({
        resourceId: operation.resourceId,
        result: { verified: true },
      }),
    };
    const worker = new OperationsWorkerService(repo, { resolve: () => executor });

    const result = await worker.processNext("worker-a", 300);

    expect(result?.status).toBe("Succeeded");
    expect(repo.markSucceeded).toHaveBeenCalledWith(
      operation.id,
      "worker-a",
      { verified: true },
      operation.resourceId,
      "Succeeded",
    );
  });

  it("schedules bounded retry for a retryable execution failure", async () => {
    const { OperationsWorkerService } = await loadWorkerModule();
    const repo = repository();
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute: vi.fn().mockRejectedValue({
        code: "PlatformUnavailable",
        message: "platform unavailable",
      }),
    };
    const worker = new OperationsWorkerService(repo, { resolve: () => executor });

    const result = await worker.processNext("worker-a", 300);

    expect(result?.status).toBe("Pending");
    expect(repo.scheduleRetry).toHaveBeenCalledWith(
      operation.id,
      "worker-a",
      expect.any(Date),
      "PlatformUnavailable",
      "platform unavailable",
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("does not emit a false success when the lease was lost before commit", async () => {
    const { OperationsWorkerService } = await loadWorkerModule();
    const repo = repository({ markSucceeded: vi.fn().mockResolvedValue(null) });
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute: vi.fn().mockResolvedValue({ result: { verified: true } }),
    };
    const worker = new OperationsWorkerService(repo, { resolve: () => executor });

    await expect(worker.processNext("worker-a", 300)).resolves.toBeNull();

    expect(repo.appendEvent).not.toHaveBeenCalledWith(
      operation.id,
      expect.objectContaining({ event: "ExecutionSucceeded" }),
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("does not emit retry/failure after a stale worker loses its lease", async () => {
    const { OperationsWorkerService } = await loadWorkerModule();
    const repo = repository({ scheduleRetry: vi.fn().mockResolvedValue(null) });
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute: vi.fn().mockRejectedValue({
        code: "PlatformUnavailable",
        message: "temporary failure",
      }),
    };
    const worker = new OperationsWorkerService(repo, { resolve: () => executor });

    await expect(worker.processNext("worker-a", 300)).resolves.toBeNull();
    expect(repo.appendEvent).not.toHaveBeenCalledWith(
      operation.id,
      expect.objectContaining({ event: "RetryScheduled" }),
    );
  });

  it("propagates persistence failure after side effects instead of misclassifying it as executor failure", async () => {
    const { OperationsWorkerService } = await loadWorkerModule();
    const dbFailure = new Error("database unavailable during terminal commit");
    const repo = repository({ markSucceeded: vi.fn().mockRejectedValue(dbFailure) });
    const executor: Executor = {
      types: ["DOMAIN_VERIFY"],
      execute: vi.fn().mockResolvedValue({ result: { verified: true } }),
    };
    const worker = new OperationsWorkerService(repo, { resolve: () => executor });

    await expect(worker.processNext("worker-a", 300)).rejects.toBe(dbFailure);
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.scheduleRetry).not.toHaveBeenCalled();
  });

  it("terminalizes exhausted expired work before claiming another Operation", async () => {
    const { OperationsWorkerService } = await loadWorkerModule();
    const exhausted: OperationRecord = {
      ...operation,
      status: "Failed",
      attempt: 5,
      maxAttempts: 5,
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: "OperationAttemptsExhausted",
      errorMessage: "attempts exhausted",
      completedAt: new Date(),
    };
    const repo = repository({
      failExhaustedOperations: vi.fn().mockResolvedValue([exhausted]),
      claimNext: vi.fn().mockResolvedValue(null),
    });
    const worker = new OperationsWorkerService(repo, {
      resolve: vi.fn(() => {
        throw new Error("must not execute");
      }),
    });

    const result = await worker.processNext("worker-a", 300);

    expect(result?.status).toBe("Failed");
    expect(repo.appendEvent).toHaveBeenCalledWith(
      exhausted.id,
      expect.objectContaining({ event: "ExecutionAttemptsExhausted" }),
    );
  });
});
