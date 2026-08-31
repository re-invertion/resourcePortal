import { describe, expect, it } from "vitest";
import {
  insufficientCapacityException,
  platformUnavailableException,
} from "./capacity-errors";

describe("Stage 15 capacity error model", () => {
  it("exposes InsufficientCapacity as a stable conflict error code", () => {
    const error = insufficientCapacityException("CPU capacity exceeded");

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      code: "InsufficientCapacity",
      message: "CPU capacity exceeded",
    });
  });

  it("exposes PlatformUnavailable as a stable service-unavailable error code", () => {
    const error = platformUnavailableException("StorageBackend is in maintenance");

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      code: "PlatformUnavailable",
      message: "StorageBackend is in maintenance",
    });
  });
});
