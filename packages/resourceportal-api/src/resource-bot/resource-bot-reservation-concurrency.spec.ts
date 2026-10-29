/* eslint-disable
  @typescript-eslint/no-explicit-any,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-member-access
  -- Prisma's dynamically shaped transaction callbacks are mocked in a
     shared in-memory database fixture; production code remains fully linted.
*/
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ResourceBotBillingService } from "./resource-bot-billing.service";
import { ResourceBotChatService } from "./resource-bot-chat.service";

const tenantId = "e0a0064f-ced2-401a-90ed-05f6ff000001";
const otherTenant = "e0a0064f-ced2-401a-90ed-05f6ff000002";
const requestId = "aa2ba8ac-c814-40f6-8e8a-aa883e1f9991";
const accountId = "ba2ba8ac-c814-40f6-8e8a-aa883e1f9991";
const actor = {
  id: "ca2ba8ac-c814-40f6-8e8a-aa883e1f9991",
  displayName: "Test Actor",
  email: "actor@example.test",
  status: "Active",
};
const price = {
  id: "da2ba8ac-c814-40f6-8e8a-aa883e1f9991",
  provider: "OpenAI",
  model: "test-model",
  inputCreditsPer1M: new Prisma.Decimal(1),
  cachedInputCreditsPer1M: new Prisma.Decimal(1),
  outputCreditsPer1M: new Prisma.Decimal(1),
  embeddingCreditsPer1M: new Prisma.Decimal(1),
};

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture() {
  type Reservation = {
    id: string; requestId: string; tenantId: string; billingAccountId: string;
    reservedCredits: Prisma.Decimal; priceVersionId: string; expiresAt: Date;
  };
  const reservations = new Map<string, Reservation>();
  const usageRecords = new Map<string, Record<string, unknown>>();
  const transactions: Array<Record<string, unknown>> = [];
  const account = {
    id: accountId, tenantId,
    balance: new Prisma.Decimal(100), informationThreshold: new Prisma.Decimal(0),
  };
  let previous: Promise<void> = Promise.resolve();
  const matches = (reservation: Reservation, where: Record<string, any>): boolean => {
    if (where.requestId && reservation.requestId !== where.requestId) return false;
    if (where.id && reservation.id !== where.id) return false;
    if (where.tenantId && reservation.tenantId !== where.tenantId) return false;
    if (where.billingAccountId && reservation.billingAccountId !== where.billingAccountId) return false;
    if (where.expiresAt?.lte && reservation.expiresAt > where.expiresAt.lte) return false;
    if (where.expiresAt?.gt && reservation.expiresAt <= where.expiresAt.gt) return false;
    return true;
  };
  const tx = {
    // The real service uses SELECT ... FOR UPDATE on BillingAccount. This test
    // serializes the *whole* callback, even across independent service objects.
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve([account])),
    resourceBotUsageRecord: {
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(usageRecords.get(where.requestId) ?? null)),
      create: vi.fn().mockImplementation(({ data }: any) => {
        const row = { ...data, createdAt: new Date() };
        usageRecords.set(data.requestId, row);
        return Promise.resolve(row);
      }),
    },
    resourceBotUsageReservation: {
      findUnique: vi.fn().mockImplementation(({ where, include }: any) => {
        const row = reservations.get(where.requestId);
        return Promise.resolve(row ? { ...row, ...(include?.priceVersion ? { priceVersion: price } : {}) } : null);
      }),
      deleteMany: vi.fn().mockImplementation(({ where }: any) => {
        let count = 0;
        for (const [key, value] of reservations) {
          if (matches(value, where)) { reservations.delete(key); count++; }
        }
        return Promise.resolve({ count });
      }),
      aggregate: vi.fn().mockImplementation(({ where }: any) => {
        let sum = new Prisma.Decimal(0);
        for (const reservation of reservations.values()) {
          if (matches(reservation, where)) sum = sum.plus(reservation.reservedCredits);
        }
        return Promise.resolve({ _sum: { reservedCredits: sum } });
      }),
      count: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve([...reservations.values()].filter((r) => matches(r, where)).length)),
      create: vi.fn().mockImplementation(({ data }: any) => {
        if (reservations.has(data.requestId)) throw new Error("UNIQUE reservation requestId");
        const row = { ...data, id: randomUUID() } as Reservation;
        reservations.set(row.requestId, row);
        return Promise.resolve(row);
      }),
      updateMany: vi.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (const [key, row] of reservations) {
          if (matches(row, where)) {
            reservations.set(key, { ...row, ...data });
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: "Example Tenant" }) },
    billingAccount: { update: vi.fn().mockImplementation(({ data }: any) => {
      account.balance = data.balance;
      return Promise.resolve(account);
    }) },
    billingTransaction: { create: vi.fn().mockImplementation(({ data }: any) => {
      const row = { ...data, id: randomUUID() };
      transactions.push(row);
      return Promise.resolve(row);
    }) },
    auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    resourceBotPriceVersion: { findFirst: vi.fn().mockResolvedValue(price) },
    resourceBotUsageReservation: {
      updateMany: tx.resourceBotUsageReservation.updateMany,
      deleteMany: tx.resourceBotUsageReservation.deleteMany,
    },
    $transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => {
      const waiting = previous;
      const gate = deferred();
      previous = gate.promise;
      await waiting;
      try { return await fn(tx); } finally { gate.resolve(); }
    }),
  };
  const billing = () => new ResourceBotBillingService(prisma as never);
  const reserve = (service: ResourceBotBillingService, tenant = tenantId) =>
    service.reserve({ tenantId: tenant, requestId, provider: "OpenAI", model: "test-model" });
  const settle = (service: ResourceBotBillingService, reservationId: string) =>
    service.settle({
      tenantId, requestId, reservationId, actor: actor as never,
      provider: "OpenAI", model: "test-model",
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 10,
      embeddingInputTokens: 5, totalTokens: 115, supportedByHelp: true,
    });
  const chat = (service: ResourceBotBillingService, retrieval: { retrieve: (...args: never[]) => Promise<unknown> }, provider: { answer: (...args: never[]) => Promise<unknown> }) =>
    new ResourceBotChatService(
      { assertEnabled: vi.fn().mockResolvedValue(undefined) } as never,
      { getRuntimeConfiguration: vi.fn().mockResolvedValue({ generationModel: "test-model" }) } as never,
      retrieval as never,
      provider as never,
      service,
      { consumeWithPolicy: vi.fn().mockResolvedValue({ allowed: true }) } as never,
      { recordResourceBotDuration: vi.fn(), recordResourceBotUsage: vi.fn(), recordResourceBotRequest: vi.fn() } as never,
    );
  return { billing, reserve, settle, chat, reservations, usageRecords, transactions, tx, account };
}

describe("ResourceBot cross-replica reservation ownership (#322)", () => {
  it("serializes two concurrent requests from separate API instances and never exposes the original reservation capability", async () => {
    const f = fixture();
    const a = f.billing();
    const b = f.billing();
    const results = await Promise.allSettled([f.reserve(a), f.reserve(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((r) => r.status === "rejected");
    expect(denied?.status).toBe("rejected");
    if (denied?.status === "rejected") {
      expect(denied.reason).toBeInstanceOf(ConflictException);
      expect(denied.reason.getResponse()).toMatchObject({ code: "ResourceBotRequestInProgress" });
      expect(JSON.stringify(denied.reason.getResponse())).not.toContain("reservationId");
    }
    expect(f.reservations.size).toBe(1);
    expect(f.tx.resourceBotUsageReservation.create).toHaveBeenCalledOnce();
  });

  it("only allows the holder of the original reservationId to release, renew, and settle", async () => {
    const f = fixture();
    const a = f.billing();
    const b = f.billing();
    const reserved = await f.reserve(a);
    expect(reserved.duplicate).toBe(false);
    if (reserved.duplicate) throw new Error("Expected new reservation");
    await b.release(requestId, tenantId, randomUUID());
    expect(f.reservations.size).toBe(1);
    await expect(b.renew(requestId, tenantId, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    await expect(f.settle(b, randomUUID())).rejects.toBeInstanceOf(ConflictException);
    expect(f.transactions).toHaveLength(0);
    const charged = await f.settle(a, reserved.reservationId);
    expect(charged.chargedCredits).toBe("0.000115");
    expect(f.transactions).toHaveLength(1);
    expect(f.reservations.size).toBe(0);
    await expect(f.settle(b, reserved.reservationId)).rejects.toBeInstanceOf(ConflictException);
    expect(f.transactions).toHaveLength(1);
  });

  it("blocks a foreign tenant's concurrent request and an already-settled replay", async () => {
    const f = fixture();
    const a = f.billing();
    const b = f.billing();
    const reserved = await f.reserve(a);
    await expect(f.reserve(b, otherTenant)).rejects.toBeInstanceOf(ConflictException);
    if (reserved.duplicate) throw new Error("Expected reservation owner");
    await f.settle(a, reserved.reservationId);
    const prior = await f.reserve(b);
    expect(prior.duplicate).toBe(true);
    expect(f.tx.resourceBotUsageReservation.create).toHaveBeenCalledOnce();
  });

  it("a failed execution can release only its own reservation; an expired owner cannot settle a replacement", async () => {
    const f = fixture();
    const a = f.billing();
    const b = f.billing();
    const initial = await f.reserve(a);
    if (initial.duplicate) throw new Error("Expected reservation owner");
    const reservation = f.reservations.get(requestId);
    if (!reservation) throw new Error("Missing reservation");
    reservation.expiresAt = new Date(Date.now() - 1000);
    const replacement = await f.reserve(b);
    if (replacement.duplicate) throw new Error("Expected fresh reservation");
    expect(replacement.reservationId).not.toBe(initial.reservationId);
    await a.release(requestId, tenantId, initial.reservationId);
    expect(f.reservations.get(requestId)?.id).toBe(replacement.reservationId);
    await expect(f.settle(a, initial.reservationId)).rejects.toBeInstanceOf(ConflictException);
    expect(f.transactions).toHaveLength(0);
    await f.settle(b, replacement.reservationId);
    expect(f.transactions).toHaveLength(1);
  });

  it("permits only one retrieval/provider generation on concurrent chat requests, then charges once", async () => {
    const f = fixture();
    const gate = deferred();
    const entered = deferred();
    const retrieval = { retrieve: vi.fn().mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { embeddingInputTokens: 1, sources: [{
        chunkId: "c", sectionId: "s", anchor: "a", title: "Help", text: "Text",
      }] };
    }) };
    const provider = { answer: vi.fn().mockResolvedValue({
      answer: "Response", supportedByHelp: true, sourceChunkIds: ["c"],
      usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, totalTokens: 5 },
    }) };
    const chatA = f.chat(f.billing(), retrieval, provider);
    const chatB = f.chat(f.billing(), retrieval, provider);
    const input = { requestId, question: "Question", history: [] };
    const first = chatA.answer(tenantId, input, actor as never);
    try {
      await entered.promise;
      await expect(chatB.answer(tenantId, input, actor as never)).rejects.toMatchObject({
        response: { code: "ResourceBotRequestInProgress" },
      });
      expect(retrieval.retrieve).toHaveBeenCalledOnce();
      expect(provider.answer).not.toHaveBeenCalled();
    } finally { gate.resolve(); }
    await expect(first).resolves.toMatchObject({ requestId });
    expect(provider.answer).toHaveBeenCalledOnce();
    expect(f.transactions).toHaveLength(1);
    expect(f.usageRecords.size).toBe(1);
  });

  it("a failed first chat releases its reservation, allowing a later retry to run", async () => {
    const f = fixture();
    const entered = deferred();
    const gate = deferred();
    const retrieval = { retrieve: vi.fn().mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      throw new Error("provider unavailable");
    }) };
    const provider = { answer: vi.fn() };
    const chatA = f.chat(f.billing(), retrieval, provider);
    const chatB = f.chat(f.billing(), retrieval, provider);
    const input = { requestId, question: "Question", history: [] };
    const first = chatA.answer(tenantId, input, actor as never);
    // Avoid an unobserved rejection before finally unblocks the first call.
    const firstError = first.catch((error: unknown) => error);
    try {
      await entered.promise;
      await expect(chatB.answer(tenantId, input, actor as never)).rejects.toBeInstanceOf(ConflictException);
    } finally { gate.resolve(); }
    expect(await firstError).toBeInstanceOf(Error);
    expect(f.reservations.size).toBe(0);
    expect(f.transactions).toHaveLength(0);
    const retry = await f.reserve(f.billing());
    expect(retry.duplicate).toBe(false);
    expect(f.reservations.size).toBe(1);
  });
});
