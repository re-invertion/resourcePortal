import { UnauthorizedException } from "@nestjs/common";
import { InstallerEnrollmentRole } from "@prisma/client";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OperationsRepository } from "../operations/operations.repository";
import type {
  CreateOperationInput,
  OperationRecord,
} from "../operations/operation.types";
import type { PrismaService } from "../prisma/prisma.service";
import { InstallerEnrollmentService } from "./installer-enrollment.service";

type RecordState = {
  id: string;
  tokenHash: string;
  role: InstallerEnrollmentRole;
  expiresAt: Date;
  consumedAt: Date | null;
  completedAt: Date | null;
  nodeId: string | null;
  createdAt: Date;
};

type EnrollmentCreateArgs = {
  data: Pick<RecordState, "tokenHash" | "role" | "expiresAt" | "consumedAt">;
};

type EnrollmentWhere = {
  tokenHash: string;
  role?: InstallerEnrollmentRole;
  consumedAt?: null | { not: null };
  expiresAt?: { gt: Date };
  completedAt?: null | { not: null };
  nodeId?: string;
};

type EnrollmentFindArgs = { where: { tokenHash: string } };
type EnrollmentUpdateArgs = {
  where: EnrollmentWhere;
  data: Partial<Pick<RecordState, "consumedAt" | "completedAt" | "nodeId">>;
};

type FakeEnrollmentDelegate = {
  create: (args: EnrollmentCreateArgs) => Promise<RecordState>;
  findUnique: (args: EnrollmentFindArgs) => Promise<RecordState | null>;
  findUniqueOrThrow: (args: EnrollmentFindArgs) => Promise<RecordState>;
  updateMany: (args: EnrollmentUpdateArgs) => Promise<{ count: number }>;
};

type FakeTransaction = { installerEnrollment: FakeEnrollmentDelegate };

function publicKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).publicKey;
}

function requiredOperation(operations: Map<string, OperationRecord>, id: string) {
  const operation = operations.get(id);
  if (!operation) throw new Error(`Missing test operation ${id}`);
  return operation;
}

function fixture() {
  const records: RecordState[] = [];
  const operations = new Map<string, OperationRecord>();
  let operationCounter = 0;

  const enrollment: FakeEnrollmentDelegate = {
    create: vi.fn(({ data }: EnrollmentCreateArgs) => {
      const record: RecordState = {
        id: `00000000-0000-0000-0000-${String(records.length + 1).padStart(12, "0")}`,
        completedAt: null,
        nodeId: null,
        createdAt: new Date(),
        ...data,
      };
      records.push(record);
      return Promise.resolve(record);
    }),
    findUnique: vi.fn(({ where }: EnrollmentFindArgs) =>
      Promise.resolve(
        records.find((record) => record.tokenHash === where.tokenHash) ?? null,
      ),
    ),
    findUniqueOrThrow: vi.fn(({ where }: EnrollmentFindArgs) => {
      const record = records.find((item) => item.tokenHash === where.tokenHash);
      if (!record) throw new Error("not found");
      return Promise.resolve(record);
    }),
    updateMany: vi.fn(({ where, data }: EnrollmentUpdateArgs) => {
      const record = records.find((item) => {
        if (item.tokenHash !== where.tokenHash) return false;
        if (where.role !== undefined && item.role !== where.role) return false;
        if (where.consumedAt === null && item.consumedAt !== null) return false;
        if (where.consumedAt?.not === null && item.consumedAt === null) return false;
        if (where.expiresAt?.gt && item.expiresAt <= where.expiresAt.gt) return false;
        if (where.completedAt === null && item.completedAt !== null) return false;
        if (where.completedAt?.not === null && item.completedAt === null) return false;
        if (where.nodeId !== undefined && item.nodeId !== where.nodeId) return false;
        return true;
      });
      if (!record) return Promise.resolve({ count: 0 });
      Object.assign(record, data);
      return Promise.resolve({ count: 1 });
    }),
  };

  const fakePrisma = {
    installerEnrollment: enrollment,
    $transaction: vi.fn((callback: (tx: FakeTransaction) => Promise<unknown>) =>
      callback({ installerEnrollment: enrollment }),
    ),
  };

  const createOperationInTransaction = vi.fn(
    (_tx: unknown, input: CreateOperationInput): Promise<OperationRecord> => {
      operationCounter += 1;
      const id = `10000000-0000-0000-0000-${String(operationCounter).padStart(12, "0")}`;
      const operation: OperationRecord = {
        id,
        type: input.type,
        tenantId: input.tenantId,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        status: "Pending",
        phase: input.phase ?? null,
        createdBy: input.createdBy,
        createdByEmail: input.createdByEmail,
        createdByDisplayName: input.createdByDisplayName,
        input: input.input ?? {},
        result: null,
        idempotencyKey: input.idempotencyKey ?? null,
        attempt: 0,
        maxAttempts: input.maxAttempts ?? 5,
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      };
      operations.set(id, operation);
      return Promise.resolve(operation);
    },
  );
  const getOperationById = vi.fn((id: string) =>
    Promise.resolve(operations.get(id) ?? null),
  );
  const repository = {
    createOperationInTransaction,
    getOperationById,
  } as unknown as OperationsRepository;

  return {
    records,
    operations,
    createOperationInTransaction,
    service: new InstallerEnrollmentService(
      fakePrisma as unknown as PrismaService,
      repository,
    ),
  };
}

describe("InstallerEnrollmentService v0.2", () => {
  it("issues a 30-minute role-bound token while storing only its SHA-256 hash", async () => {
    const { service, records } = fixture();
    const now = new Date("2026-09-05T12:00:00.000Z");
    const issued = await service.issue("worker", now);

    expect(issued.expiresAt.toISOString()).toBe("2026-09-05T12:30:00.000Z");
    expect(records[0].tokenHash).toBe(
      createHash("sha256").update(issued.token).digest("hex"),
    );
    expect(records[0].tokenHash).not.toContain(issued.token);
  });

  it("consumes a valid token and queues worker-side enrollment preparation", async () => {
    const { service, createOperationInTransaction } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));
    const key = publicKey();

    const result = await service.beginRedemption(
      issued.token,
      "worker",
      key,
      new Date("2026-09-05T12:05:00.000Z"),
    );

    expect(result).toMatchObject({ status: "pending", role: "worker" });
    expect(createOperationInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "INSTALLER_ENROLLMENT_PREPARE",
        tenantId: null,
        resourceType: "InstallerEnrollment",
        input: { role: "worker", publicKey: key },
      }),
    );
  });

  it("rejects role tampering before an operation is queued", async () => {
    const { service, createOperationInTransaction } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));

    await expect(
      service.beginRedemption(
        issued.token,
        "manager",
        publicKey(),
        new Date("2026-09-05T12:05:00.000Z"),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(createOperationInTransaction).not.toHaveBeenCalled();
  });

  it("returns only the encrypted worker result from enrollment status", async () => {
    const { service, operations } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));
    const pending = await service.beginRedemption(
      issued.token,
      "worker",
      publicKey(),
      new Date("2026-09-05T12:05:00.000Z"),
    );
    const operation = requiredOperation(operations, pending.operationId);
    operation.status = "Succeeded";
    operation.result = {
      encryptedJoinToken: "ciphertext-only",
      managerEndpoint: "10.20.0.10:2377",
      clusterId: "cluster-1",
    };

    await expect(
      service.redemptionStatus(
        issued.token,
        "worker",
        pending.operationId,
        new Date("2026-09-05T12:06:00.000Z"),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      encryptedJoinToken: "ciphertext-only",
    });
  });

  it("queues completion label work instead of applying Docker changes in the listener", async () => {
    const { service, createOperationInTransaction } = fixture();
    const issued = await service.issue("manager", new Date("2026-09-05T12:00:00.000Z"));
    await service.beginRedemption(
      issued.token,
      "manager",
      publicKey(),
      new Date("2026-09-05T12:05:00.000Z"),
    );

    const completion = await service.beginCompletion(
      issued.token,
      "manager",
      "abcdefghijklmnopqrstuvwxy",
      true,
      false,
      new Date("2026-09-05T12:06:00.000Z"),
    );

    expect(completion.status).toBe("pending");
    const queued = createOperationInTransaction.mock.calls.at(-1)?.[1];
    expect(queued?.type).toBe("INSTALLER_ENROLLMENT_COMPLETE");
    expect(queued?.input).toEqual({
      role: "manager",
      nodeId: "abcdefghijklmnopqrstuvwxy",
      controlPlane: true,
      ingress: false,
    });
  });

  it("reports completion only after the worker operation succeeds", async () => {
    const { service, operations } = fixture();
    const issued = await service.issue("worker", new Date("2026-09-05T12:00:00.000Z"));
    await service.beginRedemption(
      issued.token,
      "worker",
      publicKey(),
      new Date("2026-09-05T12:05:00.000Z"),
    );
    const completion = await service.beginCompletion(
      issued.token,
      "worker",
      "abcdefghijklmnopqrstuvwxy",
      false,
      false,
      new Date("2026-09-05T12:06:00.000Z"),
    );
    requiredOperation(operations, completion.operationId).status = "Succeeded";

    await expect(
      service.completionStatus(
        issued.token,
        "worker",
        "abcdefghijklmnopqrstuvwxy",
        completion.operationId,
        new Date("2026-09-05T12:07:00.000Z"),
      ),
    ).resolves.toEqual({ status: "completed", role: "worker" });
  });
});
