import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/types";
import type { PrismaService } from "../prisma/prisma.service";
import type { EncryptionService } from "../security/encryption.service";
import { BillingService } from "./billing.service";
import { hashVoucherCode } from "./billing-policy";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "Platform Admin",
  status: "Active",
} as unknown as AuthenticatedUser;

describe("BillingService voucher code persistence", () => {
  it("stores only hash + encrypted code and returns the plaintext code to Platform Admin", async () => {
    const encrypt = vi.fn((value: string) => `enc:${value}`);
    const decrypt = vi.fn((value: string) => value.slice(4));
    const voucherCreate = vi.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...data,
        status: "Active",
        redeemedAt: null,
        redeemedByUserId: null,
        redeemedBillingAccountId: null,
        disabledAt: null,
        disabledByUserId: null,
        createdAt: new Date("2026-09-22T20:00:00.000Z"),
      }),
    );
    const prisma = {
      voucher: { create: voucherCreate },
      auditLogEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new BillingService(
      prisma as unknown as PrismaService,
      { encrypt, decrypt } as unknown as EncryptionService,
    );

    const expiresAt = "2026-10-22T20:00:00.000Z";
    const result = await service.createVoucher(
      { valueCredits: "250", expiresAt },
      actor,
    );

    expect(result.code).toMatch(/^RPV-[A-Z0-9]+$/);
    expect(encrypt).toHaveBeenCalledWith(result.code);
    const data = voucherCreate.mock.calls[0]?.[0].data;
    expect(data.codeCiphertext).toBe(`enc:${result.code}`);
    expect(data.codeHash).toBe(hashVoucherCode(result.code));
    expect(data.codeHash).not.toContain(result.code);
    expect((data.valueCredits as Prisma.Decimal).toString()).toBe("250");
    expect((data.expiresAt as Date).toISOString()).toBe(expiresAt);
  });

  it("decrypts codes for the admin list while preserving legacy vouchers with no recoverable code", async () => {
    const rows = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        codeHash: "hash-new",
        codeCiphertext: "enc:RPV-NEWCODE",
        valueCredits: new Prisma.Decimal("100"),
        status: "Active",
        expiresAt: null,
        redeemedAt: null,
        redeemedByUserId: null,
        redeemedBillingAccountId: null,
        disabledAt: null,
        disabledByUserId: null,
        createdBy: actor.id,
        createdAt: new Date("2026-09-22T20:00:00.000Z"),
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        codeHash: "hash-legacy",
        codeCiphertext: null,
        valueCredits: new Prisma.Decimal("50"),
        status: "Active",
        expiresAt: null,
        redeemedAt: null,
        redeemedByUserId: null,
        redeemedBillingAccountId: null,
        disabledAt: null,
        disabledByUserId: null,
        createdBy: actor.id,
        createdAt: new Date("2026-09-21T20:00:00.000Z"),
      },
    ];
    const prisma = {
      voucher: { findMany: vi.fn().mockResolvedValue(rows) },
    };
    const service = new BillingService(
      prisma as unknown as PrismaService,
      {
        encrypt: vi.fn(),
        decrypt: vi.fn((value: string) => value.slice(4)),
      } as unknown as EncryptionService,
    );

    await expect(service.listVouchers()).resolves.toMatchObject([
      { code: "RPV-NEWCODE", valueCredits: "100" },
      { code: null, valueCredits: "50" },
    ]);
  });
});
