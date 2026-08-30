import { describe, expect, it } from "vitest";
import {
  isCostIncreasingSingleAppUpdate,
  isCostIncreasingVolumeResize,
} from "./billing-preflight";

describe("Stage 10 billing preflight", () => {
  const current = {
    cpu: "1.5",
    memoryBytes: 2_000_000_000n,
    gpu: 0,
    desiredReplicas: 2,
  };

  it("detects replica increases", () => {
    expect(isCostIncreasingSingleAppUpdate(current, { desiredReplicas: 3 })).toBe(true);
  });

  it("detects CPU increases", () => {
    expect(isCostIncreasingSingleAppUpdate(current, { cpu: 2 })).toBe(true);
  });

  it("detects memory increases", () => {
    expect(isCostIncreasingSingleAppUpdate(current, { memoryBytes: 3_000_000_000 })).toBe(true);
  });

  it("detects GPU increases", () => {
    expect(isCostIncreasingSingleAppUpdate(current, { gpu: 1 })).toBe(true);
  });

  it("does not block cost-reducing or metadata-only updates", () => {
    expect(
      isCostIncreasingSingleAppUpdate(current, {
        cpu: 1,
        memoryBytes: 1_000_000_000,
        gpu: 0,
        desiredReplicas: 1,
      }),
    ).toBe(false);
    expect(isCostIncreasingSingleAppUpdate(current, {})).toBe(false);
  });

  it("detects only volume growth as storage cost increase", () => {
    expect(isCostIncreasingVolumeResize(10_000n, 20_000)).toBe(true);
    expect(isCostIncreasingVolumeResize(10_000n, 10_000)).toBe(false);
    expect(isCostIncreasingVolumeResize(10_000n, 9_000)).toBe(false);
  });
});
