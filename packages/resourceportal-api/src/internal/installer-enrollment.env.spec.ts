import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateInstallerEnrollmentEnv } from "./installer-enrollment.env";

describe("validateInstallerEnrollmentEnv", () => {
  it("loads join tokens from secret files and requires private enrollment settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-enrollment-env-"));
    try {
      const database = join(dir, "database");
      const worker = join(dir, "worker");
      const manager = join(dir, "manager");
      writeFileSync(database, "postgresql://rp:secret@postgres-rp:5432/resource_portal\n");
      writeFileSync(worker, "worker-secret\n");
      writeFileSync(manager, "manager-secret\n");
      const env = {
        DATABASE_URL_FILE: database,
        INSTALLER_SWARM_WORKER_TOKEN_FILE: worker,
        INSTALLER_SWARM_MANAGER_TOKEN_FILE: manager,
        INSTALLER_SWARM_MANAGER_ENDPOINT: "10.0.0.10:2377",
        INSTALLER_STORAGE_SERVER_ADDRESS: "10.0.0.10",
        INSTALLER_CLUSTER_ID: "cluster-a",
        INSTALLER_VERSION: "0.1.0",
        INSTALLER_SWARM_ADVERTISE_ADDR: "10.0.0.10",
        INSTALLER_CLUSTER_CIDR: "10.0.0.0/24",
        INSTALLER_ENROLLMENT_TLS_CERT_FILE: "/run/secrets/installer_tls_cert",
        INSTALLER_ENROLLMENT_TLS_KEY_FILE: "/run/secrets/installer_tls_key",
      };

      expect(validateInstallerEnrollmentEnv(env)).toBe(env);
      expect(env.DATABASE_URL).toContain("postgres-rp");
      expect(env.INSTALLER_SWARM_WORKER_TOKEN).toBe("worker-secret");
      expect(env.INSTALLER_SWARM_MANAGER_TOKEN).toBe("manager-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing TLS key path", () => {
    expect(() =>
      validateInstallerEnrollmentEnv({
        DATABASE_URL: "postgresql://example",
        INSTALLER_SWARM_WORKER_TOKEN: "worker",
        INSTALLER_SWARM_MANAGER_TOKEN: "manager",
        INSTALLER_SWARM_MANAGER_ENDPOINT: "10.0.0.10:2377",
        INSTALLER_STORAGE_SERVER_ADDRESS: "10.0.0.10",
        INSTALLER_CLUSTER_ID: "cluster-a",
        INSTALLER_VERSION: "0.1.0",
        INSTALLER_SWARM_ADVERTISE_ADDR: "10.0.0.10",
        INSTALLER_CLUSTER_CIDR: "10.0.0.0/24",
        INSTALLER_ENROLLMENT_TLS_CERT_FILE: "/run/secrets/cert",
      }),
    ).toThrow("INSTALLER_ENROLLMENT_TLS_KEY_FILE is required");
  });
});
