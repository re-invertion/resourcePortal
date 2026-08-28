import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { EncryptionService } from "./encryption.service";

describe("EncryptionService", () => {
  it("encrypts and decrypts values", () => {
    const service = new EncryptionService({
      get: () => undefined,
    } as unknown as ConfigService);

    const encrypted = service.encrypt("secret-value");

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("secret-value");
    expect(service.decrypt(encrypted)).toBe("secret-value");
  });

  it("keeps legacy plaintext readable", () => {
    const service = new EncryptionService({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(service.decrypt("legacy-secret")).toBe("legacy-secret");
  });
});
