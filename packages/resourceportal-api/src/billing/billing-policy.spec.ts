import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  billingState,
  generateVoucherCode,
  hashVoucherCode,
  isVoucherRedeemable,
  normalizeLedgerAmount,
  requiresBillingReason,
} from "./billing-policy";

describe("Stage 10 billing policy", () => {
  it("derives Active above zero and outside low-balance threshold", () => {
    expect(billingState(new Prisma.Decimal("50"), new Prisma.Decimal("10"))).toEqual({
      state: "Active",
      lowBalance: false,
    });
  });

  it("derives lowBalance without changing Active state", () => {
    expect(billingState(new Prisma.Decimal("10"), new Prisma.Decimal("10"))).toEqual({
      state: "Active",
      lowBalance: true,
    });
  });

  it("derives BillingSuspended at zero", () => {
    expect(billingState(new Prisma.Decimal("0"), new Prisma.Decimal("10"))).toEqual({
      state: "BillingSuspended",
      lowBalance: false,
    });
  });

  it("derives BillingSuspended below zero", () => {
    expect(billingState(new Prisma.Decimal("-0.01"), new Prisma.Decimal("10"))).toEqual({
      state: "BillingSuspended",
      lowBalance: false,
    });
  });

  it("hashes voucher plaintext without retaining plaintext", () => {
    const code = "RPV-0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const hash = hashVoucherCode(code);
    expect(hash).not.toBe(code);
    expect(hash).toHaveLength(64);
    expect(hashVoucherCode(code)).toBe(hash);
  });

  it("generates distinct cryptographically random voucher codes", () => {
    const first = generateVoucherCode();
    const second = generateVoucherCode();
    expect(first).toMatch(/^RPV-[A-F0-9]{48}$/);
    expect(second).toMatch(/^RPV-[A-F0-9]{48}$/);
    expect(first).not.toBe(second);
  });

  it("accepts an active non-expired voucher", () => {
    expect(
      isVoucherRedeemable(
        { status: "Active", expiresAt: new Date("2026-09-01T00:00:00Z") },
        new Date("2026-08-30T20:00:00Z"),
      ),
    ).toBe(true);
  });

  it("rejects expired vouchers", () => {
    expect(
      isVoucherRedeemable(
        { status: "Active", expiresAt: new Date("2026-08-30T19:59:59Z") },
        new Date("2026-08-30T20:00:00Z"),
      ),
    ).toBe(false);
  });

  it("rejects redeemed and disabled vouchers", () => {
    expect(isVoucherRedeemable({ status: "Redeemed", expiresAt: null }, new Date())).toBe(false);
    expect(isVoucherRedeemable({ status: "Disabled", expiresAt: null }, new Date())).toBe(false);
  });

  it("makes credit-adding ledger entries positive", () => {
    for (const type of ["Payment", "TopUp", "VoucherRedeem", "Refund"] as const) {
      expect(normalizeLedgerAmount(type, new Prisma.Decimal("2.5")).toString()).toBe("2.5");
    }
  });

  it("makes UsageCharge negative", () => {
    expect(normalizeLedgerAmount("UsageCharge", new Prisma.Decimal("2.5")).toString()).toBe("-2.5");
  });

  it("preserves signed Correction amounts", () => {
    expect(normalizeLedgerAmount("Correction", new Prisma.Decimal("-3.25")).toString()).toBe("-3.25");
    expect(normalizeLedgerAmount("Correction", new Prisma.Decimal("4.25")).toString()).toBe("4.25");
  });

  it("requires a reason for Refund and Correction only", () => {
    expect(requiresBillingReason("Refund")).toBe(true);
    expect(requiresBillingReason("Correction")).toBe(true);
    expect(requiresBillingReason("Payment")).toBe(false);
    expect(requiresBillingReason("TopUp")).toBe(false);
    expect(requiresBillingReason("VoucherRedeem")).toBe(false);
    expect(requiresBillingReason("UsageCharge")).toBe(false);
  });
});
