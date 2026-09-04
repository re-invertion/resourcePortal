import { StorageBackendStatus, StorageBackendType } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("Stage 14 Prisma storage backend contract", () => {
  it("generates the LocalFilesystem backend type and lifecycle status enums", () => {
    expect(StorageBackendType.LocalFilesystem).toBe("LocalFilesystem");
    expect(StorageBackendStatus.Ready).toBe("Ready");
    expect(StorageBackendStatus.Error).toBe("Error");
  });
});
