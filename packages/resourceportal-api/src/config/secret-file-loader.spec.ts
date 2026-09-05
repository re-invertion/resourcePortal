import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSecretFiles } from "./secret-file-loader";

const dirs: string[] = [];
function secretFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "rp-secret-file-"));
  dirs.push(dir);
  const path = join(dir, "secret");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadSecretFiles", () => {
  it("loads an allow-listed secret from an absolute *_FILE path", () => {
    const path = secretFile("worker-token\n");
    const env = { INTERNAL_WORKER_TOKEN_FILE: path };

    expect(loadSecretFiles(env)).toMatchObject({
      INTERNAL_WORKER_TOKEN: "worker-token",
      INTERNAL_WORKER_TOKEN_FILE: path,
    });
  });

  it("keeps a direct secret value when both direct and *_FILE are set", () => {
    const path = secretFile("from-file\n");
    const env = {
      INTERNAL_WORKER_TOKEN: "direct-value",
      INTERNAL_WORKER_TOKEN_FILE: path,
    };

    expect(loadSecretFiles(env).INTERNAL_WORKER_TOKEN).toBe("direct-value");
  });

  it("rejects relative secret file paths", () => {
    expect(() =>
      loadSecretFiles({ INTERNAL_WORKER_TOKEN_FILE: "run/secrets/worker" }),
    ).toThrow("INTERNAL_WORKER_TOKEN_FILE must be an absolute path");
  });

  it("rejects unreadable secret file paths without exposing secret content", () => {
    expect(() =>
      loadSecretFiles({ INTERNAL_WORKER_TOKEN_FILE: "/run/secrets/missing-rp-test" }),
    ).toThrow("Unable to read INTERNAL_WORKER_TOKEN_FILE");
  });

  it("ignores arbitrary *_FILE variables outside the production secret allow-list", () => {
    const path = secretFile("should-not-load\n");
    const env = { UNRELATED_FILE: path };

    expect(loadSecretFiles(env)).toEqual(env);
  });
});
