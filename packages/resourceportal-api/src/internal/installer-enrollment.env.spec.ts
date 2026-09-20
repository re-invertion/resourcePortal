import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateInstallerEnrollmentEnv } from "./installer-enrollment.env";

describe("validateInstallerEnrollmentEnv v0.2", () => {
  it("requires only DB and TLS material for the network-facing listener", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-enrollment-env-"));
    const db = join(dir, "db");
    const cert = join(dir, "tls.crt");
    const key = join(dir, "tls.key");
    writeFileSync(db, "postgresql://example\n");
    writeFileSync(cert, "cert\n");
    writeFileSync(key, "key\n");

    const env = validateInstallerEnrollmentEnv({
      DATABASE_URL_FILE: db,
      INSTALLER_ENROLLMENT_TLS_CERT_FILE: cert,
      INSTALLER_ENROLLMENT_TLS_KEY_FILE: key,
    });

    expect(env.DATABASE_URL).toBe("postgresql://example");
    expect(env.INSTALLER_SWARM_WORKER_TOKEN).toBeUndefined();
    expect(env.INSTALLER_SWARM_MANAGER_TOKEN).toBeUndefined();
  });

  it("does not require Docker/Swarm credential environment", () => {
    expect(() =>
      validateInstallerEnrollmentEnv({
        DATABASE_URL: "postgresql://example",
        INSTALLER_ENROLLMENT_TLS_CERT_FILE: "/run/secrets/tls.crt",
        INSTALLER_ENROLLMENT_TLS_KEY_FILE: "/run/secrets/tls.key",
      }),
    ).not.toThrow();
  });
});
