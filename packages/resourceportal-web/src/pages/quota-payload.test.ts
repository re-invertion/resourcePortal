import { describe, expect, it } from "vitest";
import { buildQuotaMutation } from "./quota-payload";

describe("quota mutation mapping", () => {
  it("fills required fields when quota does not exist yet", () => {
    expect(buildQuotaMutation(null, { maxSingleApps: 100, maxVolumes: 100 })).toEqual({
      cpu: 0,
      memoryBytes: 0,
      gpu: 0,
      storageBytes: 0,
      maxSingleApps: 100,
      maxVolumes: 100,
    });
  });

  it("keeps updates partial when quota already exists", () => {
    expect(buildQuotaMutation({ id: "quota-1", cpu: "4" }, { maxVolumes: 25 })).toEqual({
      maxVolumes: 25,
    });
  });

  it("drops non-quota fields from user JSON", () => {
    expect(buildQuotaMutation(null, { maxVolumes: 5, tenantId: "other", id: "quota-2" })).toEqual({
      cpu: 0,
      memoryBytes: 0,
      gpu: 0,
      storageBytes: 0,
      maxSingleApps: 0,
      maxVolumes: 5,
    });
  });
});
