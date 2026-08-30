import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertFullMinute,
  computeMinuteCost,
  creditsToPln,
  selectEffectivePriceList,
  storageMinuteCost,
} from "./billing-math";

describe("Stage 10 billing math", () => {
  it("accepts only full-minute UTC price-list timestamps", () => {
    expect(() => assertFullMinute(new Date("2026-08-30T20:15:00.000Z"))).not.toThrow();
    expect(() => assertFullMinute(new Date("2026-08-30T20:15:01.000Z"))).toThrow(
      "PriceListEffectiveFromMustBeFullMinute",
    );
    expect(() => assertFullMinute(new Date("2026-08-30T20:15:00.001Z"))).toThrow(
      "PriceListEffectiveFromMustBeFullMinute",
    );
  });

  it("selects the newest price list effective at the period start", () => {
    const selected = selectEffectivePriceList(
      [
        { id: "v1", version: 1, effectiveFrom: new Date("2026-08-30T20:00:00Z") },
        { id: "v2", version: 2, effectiveFrom: new Date("2026-08-30T21:00:00Z") },
      ],
      new Date("2026-08-30T21:15:00Z"),
    );

    expect(selected?.id).toBe("v2");
  });

  it("returns no price list before the first effective version", () => {
    expect(
      selectEffectivePriceList(
        [{ id: "v1", version: 1, effectiveFrom: new Date("2026-08-30T20:00:00Z") }],
        new Date("2026-08-30T19:59:00Z"),
      ),
    ).toBeUndefined();
  });

  it("derives PLN at the fixed 1 credit = 0.01 PLN conversion", () => {
    expect(creditsToPln(new Prisma.Decimal("123.456789")).toString()).toBe("1.23456789");
  });

  it("calculates one-minute compute cost with decimal arithmetic", () => {
    const cost = computeMinuteCost({
      billedReplicas: 2,
      cpu: new Prisma.Decimal("1.5"),
      memoryBytes: 2_000_000_000n,
      gpu: 1,
      cpuCreditsPerVcpuHour: new Prisma.Decimal("0.50"),
      memoryCreditsPerGbHour: new Prisma.Decimal("0.25"),
      gpuCreditsPerGpuHour: new Prisma.Decimal("60.00"),
    });

    expect(cost.toFixed(6)).toBe("2.041667");
  });

  it("uses configured volume size for one-minute storage cost", () => {
    const cost = storageMinuteCost({
      sizeBytes: 120_000_000_000n,
      storageCreditsPerGbHour: new Prisma.Decimal("0.025"),
    });

    expect(cost.toFixed(6)).toBe("0.050000");
  });

  it("clamps billed replicas to the smaller actual/effective replica count", () => {
    const cost = computeMinuteCost({
      billedReplicas: Math.min(5, 2),
      cpu: new Prisma.Decimal("1"),
      memoryBytes: 0n,
      gpu: 0,
      cpuCreditsPerVcpuHour: new Prisma.Decimal("0.50"),
      memoryCreditsPerGbHour: new Prisma.Decimal("0.25"),
      gpuCreditsPerGpuHour: new Prisma.Decimal("60"),
    });

    expect(cost.toFixed(6)).toBe("0.016667");
  });

  it("charges zero compute when the effective replica count is zero", () => {
    const cost = computeMinuteCost({
      billedReplicas: 0,
      cpu: new Prisma.Decimal("8"),
      memoryBytes: 32_000_000_000n,
      gpu: 4,
      cpuCreditsPerVcpuHour: new Prisma.Decimal("0.50"),
      memoryCreditsPerGbHour: new Prisma.Decimal("0.25"),
      gpuCreditsPerGpuHour: new Prisma.Decimal("60"),
    });

    expect(cost.isZero()).toBe(true);
  });
});
