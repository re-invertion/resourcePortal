import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.validation";

const validBaseEnv = {
  AUTH_MODE: "dev",
  DATABASE_URL: "postgresql://resource_portal:resource_portal@localhost:5433/resource_portal",
  NODE_ENV: "development",
};

describe("validateEnv", () => {
  it("accepts the default development auth mode", () => {
    expect(validateEnv(validBaseEnv)).toBe(validBaseEnv);
  });

  it("rejects unsupported auth modes", () => {
    expect(() => validateEnv({ ...validBaseEnv, AUTH_MODE: "unknown" })).toThrow(
      "AUTH_MODE must be one of",
    );
  });

  it("requires OIDC settings when OIDC auth is enabled", () => {
    expect(() => validateEnv({ ...validBaseEnv, AUTH_MODE: "oidc" })).toThrow(
      "OIDC_ISSUER_URL is required; OIDC_CLIENT_ID is required; OIDC_AUDIENCE is required; AUTH_COOKIE_SECRET is required",
    );
  });

  it("requires a long enough cookie secret for OIDC auth", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        AUTH_COOKIE_SECRET: "short",
        AUTH_MODE: "zitadel",
        OIDC_AUDIENCE: "resource-portal",
        OIDC_CLIENT_ID: "resource-portal",
        OIDC_ISSUER_URL: "http://localhost:8080",
      }),
    ).toThrow("AUTH_COOKIE_SECRET must be at least 20 characters");
  });

  it("accepts OIDC auth when required settings are present", () => {
    const env = {
      ...validBaseEnv,
      AUTH_COOKIE_SECRET: "ResourcePortalCookieSecret",
      AUTH_MODE: "zitadel",
      OIDC_AUDIENCE: "resource-portal",
      OIDC_CLIENT_ID: "resource-portal",
      OIDC_ISSUER_URL: "http://localhost:8080",
    };
    expect(validateEnv(env)).toBe(env);
  });

  it("accepts a safe Traefik certificate resolver name", () => {
    const env = { ...validBaseEnv, TRAEFIK_CERT_RESOLVER: "letsencrypt-prod_1" };
    expect(validateEnv(env)).toBe(env);
  });

  it("rejects malformed Traefik certificate resolver names", () => {
    expect(() =>
      validateEnv({ ...validBaseEnv, TRAEFIK_CERT_RESOLVER: "let's encrypt" }),
    ).toThrow(
      "TRAEFIK_CERT_RESOLVER must contain only letters, numbers, underscore, or hyphen",
    );
  });

  it("accepts positive stage 9 reconciliation timings", () => {
    const env = {
      ...validBaseEnv,
      TRAEFIK_TLS_OBSERVE_TIMEOUT_MS: "5000",
      DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS: "60000",
      INGRESS_RECONCILE_INTERVAL_MS: "15000",
    };
    expect(validateEnv(env)).toBe(env);
  });

  it("rejects invalid stage 9 reconciliation timings", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        TRAEFIK_TLS_OBSERVE_TIMEOUT_MS: "0",
        DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS: "invalid",
        INGRESS_RECONCILE_INTERVAL_MS: "-1",
      }),
    ).toThrow(
      "TRAEFIK_TLS_OBSERVE_TIMEOUT_MS must be a positive integer; DOMAIN_CERTIFICATE_RECONCILE_INTERVAL_MS must be a positive integer; INGRESS_RECONCILE_INTERVAL_MS must be a positive integer",
    );
  });

  it("accepts a positive Stage 13 infrastructure reconcile interval", () => {
    const env = {
      ...validBaseEnv,
      SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS: "30000",
    };
    expect(validateEnv(env)).toBe(env);
  });

  it("rejects an invalid Stage 13 infrastructure reconcile interval", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS: "0",
      }),
    ).toThrow(
      "SWARM_INFRASTRUCTURE_RECONCILE_INTERVAL_MS must be a positive integer",
    );
  });

  it("accepts positive Stage 14 storage reconciliation and probe timings", () => {
    const env = {
      ...validBaseEnv,
      STORAGE_BACKEND_RECONCILE_INTERVAL_MS: "30000",
      STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: "120000",
    };
    expect(validateEnv(env)).toBe(env);
  });

  it("rejects invalid Stage 14 storage reconciliation and probe timings", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        STORAGE_BACKEND_RECONCILE_INTERVAL_MS: "0",
        STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: "invalid",
      }),
    ).toThrow(
      "STORAGE_BACKEND_RECONCILE_INTERVAL_MS must be a positive integer; STORAGE_REMOTE_VALIDATION_TIMEOUT_MS must be a positive integer",
    );
  });


  it("accepts canonical Stage 14 physical and runtime roots", () => {
    const env = {
      ...validBaseEnv,
      RESOURCE_STORAGE_BASE_PATH: "/srv/resource-portal/storage",
      RESOURCE_VOLUME_RUNTIME_ROOT: "/mnt/resourceportal/volumes",
      RESOURCE_SECRET_RUNTIME_ROOT: "/mnt/resourceportal/secrets",
      RESOURCE_PLATFORM_RUNTIME_ROOT: "/mnt/resourceportal/platform",
    };
    expect(validateEnv(env)).toBe(env);
  });

  it("rejects relative Stage 14 physical and runtime roots", () => {
    expect(() => validateEnv({
      ...validBaseEnv,
      RESOURCE_STORAGE_BASE_PATH: "srv/resource-portal/storage",
      RESOURCE_VOLUME_RUNTIME_ROOT: "mnt/resourceportal/volumes",
    })).toThrow(
      "RESOURCE_STORAGE_BASE_PATH must be an absolute path; RESOURCE_VOLUME_RUNTIME_ROOT must be an absolute path",
    );
  });

  it("requires secure cookies, a non-default internal token and encryption in production", () => {
    expect(() => validateEnv({ ...validBaseEnv, NODE_ENV: "production" })).toThrow(
      "AUTH_COOKIE_SECURE must be true in production; RESOURCE_ENCRYPTION_KEY is required; INTERNAL_WORKER_TOKEN must be changed in production",
    );
  });

  it("loads production secrets from *_FILE before validating the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-env-secret-"));
    try {
      const databaseFile = join(dir, "database-url");
      const encryptionFile = join(dir, "encryption-key");
      const workerFile = join(dir, "worker-token");
      writeFileSync(databaseFile, "postgresql://rp:secret@postgres-rp:5432/resource_portal\n");
      writeFileSync(encryptionFile, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\n");
      writeFileSync(workerFile, "production-worker-token\n");
      const env = {
        ...validBaseEnv,
        DATABASE_URL: undefined,
        DATABASE_URL_FILE: databaseFile,
        RESOURCE_ENCRYPTION_KEY_FILE: encryptionFile,
        INTERNAL_WORKER_TOKEN_FILE: workerFile,
        AUTH_COOKIE_SECURE: "true",
        NODE_ENV: "production",
      };

      expect(validateEnv(env)).toBe(env);
      expect(env.DATABASE_URL).toContain("postgres-rp:5432");
      expect(env.RESOURCE_ENCRYPTION_KEY).toMatch(/^MDEy/);
      expect(env.INTERNAL_WORKER_TOKEN).toBe("production-worker-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts production when hardening and Stage 14 storage settings are present", () => {
    const env = {
      ...validBaseEnv,
      AUTH_COOKIE_SECURE: "true",
      INTERNAL_WORKER_TOKEN: "changed-production-token",
      NODE_ENV: "production",
      NFS_GANESHA_SERVER: "10.0.0.15",
      RESOURCE_ENCRYPTION_KEY:
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      STORAGE_BACKEND_RECONCILE_INTERVAL_MS: "30000",
      STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: "120000",
    };
    expect(validateEnv(env)).toBe(env);
  });
});
