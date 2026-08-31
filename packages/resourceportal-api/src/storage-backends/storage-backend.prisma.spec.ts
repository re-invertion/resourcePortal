import { StorageBackendStatus, StorageBackendType } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("Stage 14 Prisma storage backend contract", () => {
  it("generates the CephFS backend type and lifecycle status enums", () => {
    expect(StorageBackendType.CephFS).toBe("CephFS");
    expect(StorageBackendStatus.Ready).toBe("Ready");
    expect(StorageBackendStatus.Error).toBe("Error");
  });
});
