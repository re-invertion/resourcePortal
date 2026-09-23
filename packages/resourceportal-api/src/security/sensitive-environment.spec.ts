import { describe, expect, it, vi } from "vitest";
import { EncryptionService } from "./encryption.service";
import {
  hasProtectedSensitiveEnvironment,
  protectDeploymentStackConfig,
  protectSensitiveEnvironment,
  revealSensitiveEnvironment,
} from "./sensitive-environment";

function encryption() {
  return {
    encrypt: vi.fn((value: string) => `enc:v1:protected:${Buffer.from(value).toString("base64url")}`),
    decrypt: vi.fn((value: string) => Buffer.from(value.split(":").at(-1)!, "base64url").toString("utf8")),
  } as unknown as EncryptionService;
}

describe("sensitive deployment environment", () => {
  it("protects password/token-like environment values and leaves ordinary config readable", () => {
    const crypto = encryption();
    const protectedEnv = protectSensitiveEnvironment(
      {
        API_URL: "https://api.example.test",
        POSTGRES_PASSWORD: "super-secret",
        PENPOT_SECRET_KEY: "secret-key",
      },
      crypto,
    );

    expect(protectedEnv.API_URL).toBe("https://api.example.test");
    expect(protectedEnv.POSTGRES_PASSWORD).toMatch(/^enc:v1:/);
    expect(protectedEnv.PENPOT_SECRET_KEY).toMatch(/^enc:v1:/);
    expect(revealSensitiveEnvironment(protectedEnv, crypto)).toEqual({
      API_URL: "https://api.example.test",
      POSTGRES_PASSWORD: "super-secret",
      PENPOT_SECRET_KEY: "secret-key",
    });
  });

  it("protects sensitive direct env and attached variable values in a deployment snapshot", () => {
    const crypto = encryption();
    const source = JSON.stringify({
      singleApps: [
        {
          environment: { POSTGRES_PASSWORD: "db-pass", LOG_LEVEL: "info" },
          variables: [
            { targetName: "API_TOKEN", value: "token-value" },
            { targetName: "REGION", value: "eu" },
          ],
        },
      ],
    });

    const result = protectDeploymentStackConfig(source, crypto);
    const parsed = JSON.parse(result.stackConfig) as unknown as {
      singleApps: Array<{
        environment: Record<string, string>;
        variables: Array<{ value: string }>;
      }>;
    };
    expect(result.protectedValues).toBe(2);
    expect(parsed.singleApps[0].environment.POSTGRES_PASSWORD).toMatch(/^enc:v1:/);
    expect(parsed.singleApps[0].environment.LOG_LEVEL).toBe("info");
    expect(parsed.singleApps[0].variables[0].value).toMatch(/^enc:v1:/);
    expect(parsed.singleApps[0].variables[1].value).toBe("eu");
    expect(hasProtectedSensitiveEnvironment(result.stackConfig)).toBe(true);
  });
});
