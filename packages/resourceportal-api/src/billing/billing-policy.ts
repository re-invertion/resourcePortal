import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";

export type BillingLedgerType =
  | "TopUp"
  | "VoucherRedeem"
  | "Payment"
  | "UsageCharge"
  | "Refund"
  | "Correction";

export function billingState(
  balance: Prisma.Decimal,
  informationThreshold: Prisma.Decimal,
) {
  if (balance.lte(0)) {
    return { state: "BillingSuspended" as const, lowBalance: false };
  }

  return {
    state: "Active" as const,
    lowBalance: balance.lte(informationThreshold),
  };
}

export function generateVoucherCode() {
  return `RPV-${randomBytes(24).toString("hex").toUpperCase()}`;
}

export function hashVoucherCode(code: string) {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export function isVoucherRedeemable(
  voucher: { status: string; expiresAt: Date | null },
  now: Date,
) {
  return (
    voucher.status === "Active" &&
    (voucher.expiresAt === null || voucher.expiresAt.getTime() > now.getTime())
  );
}

export function normalizeLedgerAmount(
  type: BillingLedgerType,
  amount: Prisma.Decimal,
) {
  switch (type) {
    case "Payment":
    case "TopUp":
    case "VoucherRedeem":
    case "Refund":
      return amount.abs();
    case "UsageCharge":
      return amount.abs().neg();
    case "Correction":
      return amount;
  }
}

export function requiresBillingReason(type: BillingLedgerType) {
  return type === "Refund" || type === "Correction";
}
