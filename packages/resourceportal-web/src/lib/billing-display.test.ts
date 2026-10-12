import { describe, expect, it } from "vitest";
import { formatCreditAmount, formatPlnAmount, quotaBytesDisplay, quotaDisplay } from "./billing-display";

describe("billing display precision", () => {
  it("shows formatted PLN with 2 decimal places and grouped thousands", () => {
    expect(formatPlnAmount("99999899.6100446605").replace(/\s/g, " ")).toBe("99 999 899,61");
    expect(formatPlnAmount("0")).toBe("0,00");
    expect(formatPlnAmount(null)).toBe("—");
  });
  it("formats credits without leaking raw 10-decimal precision", () => {
    expect(formatCreditAmount("9999989961.00446605").replace(/\s/g, " ")).toBe("9 999 989 961");
  });
  it("distinguishes missing quotas from zero enforced capacity", () => {
    expect(quotaDisplay(undefined)).toBe("Not configured");
    expect(quotaDisplay(0, "cores")).toBe("0 cores (no capacity)");
    expect(quotaBytesDisplay(null)).toBe("Not configured");
    expect(quotaBytesDisplay(0)).toBe("0 GiB (no capacity)");
    expect(quotaBytesDisplay("4294967296")).toBe("4 GiB");
  });
});
