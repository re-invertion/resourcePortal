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

const validProductionEnv = {
  ...validBaseEnv,
  AUTH_MODE: "zitadel",
  AUTH_COOKIE_SECURE: "true",
  AUTH_COOKIE_SECRET: "ResourcePortalProductionCookieSecret",
  INTERNAL_WORKER_TOKEN: "changed-production-token",
  NODE_ENV: "production",
  OIDC_AUDIENCE: "resource-portal",
  OIDC_CLIENT_ID: "resource-portal",
  OIDC_ISSUER_URL: "https://auth.example.com",
  RESOURCE_ENCRYPTION_KEY:
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
};

describe("validateEnv", () => {
  it("accepts the default development auth mode", () => {
    expect(validateEnv(validBaseEnv)).toBe(validBaseEnv);
  });

  it("fails startup if App Consumer token gating is enabled without independent certification and signature key", () => {
    expect(() => validateEnv({
      ...validBaseEnv, RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
    })).toThrow("App Consumer Actions V2 requires explicit isolated HTTPS certification");
    expect(() => validateEnv({
      ...validBaseEnv, RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: "too-short",
    })).toThrow("RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY must be at least 32 characters");
    const valid = { ...validBaseEnv, RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: "mock-isolated-hmac-key-32-or-more-characters",
      RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID: "123456789",
      RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL: "https://rp.example.com/api/app-consumer-actions/preaccesstoken",
      ZITADEL_MANAGEMENT_TOKEN: "read-only-test-pat",
      ZITADEL_ORGANIZATION_ID: "org-1",
      OIDC_ISSUER_URL: "https://auth.example.com",
      RP_INVITATION_ONBOARDING_ENABLED: "true",
      OIDC_INVITATION_CLIENT_ID: "first-login-only-client",
      OIDC_INVITATION_CLIENT_SECRET: "confidential-onboarding-client-secret-00001",
      OIDC_INVITATION_REDIRECT_URI: "https://rp.example.com/api/invitations/onboard/callback",
      PUBLIC_API_URL: "https://rp.example.com",
      OIDC_CLIENT_ID: "rp-web-client",
      OIDC_CLI_CLIENT_ID: "rp-cli-client",
    };
    expect(validateEnv(valid)).toBe(valid);
  });

  it("requires OIDC and a canonical HTTPS API origin when resource-bound MCP OAuth is enabled", () => {
    const base = { ...validBaseEnv, RP_MCP_RESOURCE_OAUTH_ENABLED: "true" };
    expect(() => validateEnv(base)).toThrow("MCP resource OAuth requires PUBLIC_API_URL");
    expect(() => validateEnv({ ...base, PUBLIC_API_URL: "http://rp.example.com" }))
      .toThrow("MCP resource OAuth requires PUBLIC_API_URL");
    expect(() => validateEnv({ ...base, PUBLIC_API_URL: "https://rp.example.com",
      AUTH_MODE: "dev" })).toThrow("MCP resource OAuth requires an OIDC-authenticated RP session");
    const configured = {
      ...base, AUTH_MODE: "oidc",
      PUBLIC_API_URL: "https://rp.example.com",
      AUTH_COOKIE_SECRET: "correct-32-character-secret-value",
      OIDC_ISSUER_URL: "https://auth.example.com",
      OIDC_CLIENT_ID: "rp-web",
      OIDC_AUDIENCE: "rp-web",
      RESOURCE_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: "certified-signature-key-longer-than-32-characters",
      RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID: "12345",
      RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL:
        "https://rp.example.com/api/app-consumer-actions/preaccesstoken",
      ZITADEL_MANAGEMENT_TOKEN: "test-management-token",
      ZITADEL_ORGANIZATION_ID: "123456",
      RP_INVITATION_ONBOARDING_ENABLED: "true",
      OIDC_INVITATION_CLIENT_ID: "rp-invite-client",
      OIDC_INVITATION_CLIENT_SECRET: "invitation-credential-more-than-24-characters",
      OIDC_INVITATION_REDIRECT_URI:
        "https://rp.example.com/api/invitations/onboard/callback",
    };
    expect(validateEnv(configured)).toBe(configured);
    expect(validateEnv({ ...configured, RP_MCP_RESOURCE_OAUTH_ENABLED: "auto" }))
      .toMatchObject({ RP_MCP_RESOURCE_OAUTH_ENABLED: "auto" });
    expect(() => validateEnv({ ...configured, RP_MCP_RESOURCE_OAUTH_ENABLED: "unknown" }))
      .toThrow("RP_MCP_RESOURCE_OAUTH_ENABLED must be true, false, or auto");
    expect(() => validateEnv({ ...configured, RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "false" }))
      .toThrow("MCP resource OAuth requires certified issuer-global App Consumer Action");
    expect(() => validateEnv({ ...configured, RESOURCE_ENCRYPTION_KEY: "" }))
      .toThrow("MCP resource OAuth requires a 32-byte RESOURCE_ENCRYPTION_KEY");
  });

  it("rejects enabling App User login with an unbound, ambiguous or non-HTTPS ZITADEL target", () => {
    const certified = {
      ...validBaseEnv,
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_SIGNING_KEY: "an-isolated-signature-key-longer-than-32-bytes",
      ZITADEL_MANAGEMENT_TOKEN: "read-only-test-pat",
      ZITADEL_ORGANIZATION_ID: "org-1",
      OIDC_ISSUER_URL: "https://auth.example.com",
    };
    expect(() => validateEnv({ ...certified })).toThrow(
      "RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID is required",
    );
    expect(() => validateEnv({ ...certified,
      RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID: "not-a-number",
      RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL: "http://rp.example.com/api/app-consumer-actions/preaccesstoken",
    })).toThrow("RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID must be a ZITADEL target ID");
    expect(() => validateEnv({ ...certified,
      RP_APP_CONSUMER_ACTIONS_V2_TARGET_ID: "12345",
      RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL: "https://rp.example.com/other",
    })).toThrow("RP_APP_CONSUMER_ACTIONS_V2_CALLBACK_URL must be the exact secure callback URL");
  });

  it("requires isolated invitation client before activating issuer-global exact-client authorization", () => {
    expect(() => validateEnv({
      ...validBaseEnv,
      RP_APP_CONSUMER_ACTIONS_V2_ENABLED: "true",
      RP_APP_CONSUMER_ACTIONS_V2_CERTIFIED: "true",
    })).toThrow("Global exact-client Action requires a dedicated first-login invitation client");
  });

  it("rejects an invitation identity client sharing RP Web/CLI physical credentials or unsafe callback", () => {
    const base = {
      ...validBaseEnv,
      RP_INVITATION_ONBOARDING_ENABLED: "true",
      OIDC_INVITATION_CLIENT_ID: "invite",
      OIDC_INVITATION_CLIENT_SECRET: "some-very-long-test-only-client-secret",
      OIDC_INVITATION_REDIRECT_URI: "https://rp.example.com/api/invitations/onboard/callback",
      PUBLIC_API_URL: "https://rp.example.com",
      OIDC_CLIENT_ID: "web", OIDC_CLI_CLIENT_ID: "cli",
    };
    expect(validateEnv(base)).toBe(base);
    expect(() => validateEnv({ ...base, OIDC_INVITATION_CLIENT_ID: "web" }))
      .toThrow("physically distinct");
    expect(() => validateEnv({ ...base, OIDC_INVITATION_CLIENT_ID: "cli" }))
      .toThrow("physically distinct");
    expect(() => validateEnv({ ...base,
      OIDC_INVITATION_REDIRECT_URI: "https://attacker.example.com/api/invitations/onboard/callback",
    })).toThrow("callback must match public HTTPS RP API origin");
    expect(() => validateEnv({ ...base, OIDC_INVITATION_CLIENT_SECRET: "short" }))
      .toThrow("OIDC_INVITATION_CLIENT_SECRET must be at least 24 characters");
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

  it("rejects dev authentication in production even when every other hardening value is valid", () => {
    expect(() =>
      validateEnv({
        ...validProductionEnv,
        AUTH_MODE: "dev",
      }),
    ).toThrow("AUTH_MODE=dev is not allowed in production");
  });

  it("rejects implicit dev authentication when AUTH_MODE is omitted in production", () => {
    expect(() => {
      const env = { ...validProductionEnv, AUTH_MODE: undefined };
      validateEnv(env);
    }).toThrow("AUTH_MODE=dev is not allowed in production");
  });

  it("treats production and dev auth mode case/whitespace variants as production dev auth", () => {
    expect(() =>
      validateEnv({
        ...validProductionEnv,
        AUTH_MODE: " DEV ",
        NODE_ENV: " Production ",
      }),
    ).toThrow("AUTH_MODE=dev is not allowed in production");
  });

  it("requires secure cookies, a non-default internal token and encryption in production", () => {
    expect(() =>
      validateEnv({
        ...validProductionEnv,
        AUTH_COOKIE_SECURE: undefined,
        INTERNAL_WORKER_TOKEN: undefined,
        RESOURCE_ENCRYPTION_KEY: undefined,
      }),
    ).toThrow(
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
        ...validProductionEnv,
        DATABASE_URL: undefined,
        DATABASE_URL_FILE: databaseFile,
        RESOURCE_ENCRYPTION_KEY: undefined,
        RESOURCE_ENCRYPTION_KEY_FILE: encryptionFile,
        INTERNAL_WORKER_TOKEN: undefined,
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
      ...validProductionEnv,
      NFS_GANESHA_SERVER: "10.0.0.15",
      STORAGE_BACKEND_RECONCILE_INTERVAL_MS: "30000",
      STORAGE_REMOTE_VALIDATION_TIMEOUT_MS: "120000",
    };
    expect(validateEnv(env)).toBe(env);
  });
  it("validates the Worker heartbeat staleness threshold used by API diagnostics", () => {
    expect(
      validateEnv({ ...validBaseEnv, WORKER_HEALTH_STALE_SECONDS: "30" }),
    ).toMatchObject({ WORKER_HEALTH_STALE_SECONDS: "30" });
    expect(() =>
      validateEnv({ ...validBaseEnv, WORKER_HEALTH_STALE_SECONDS: "0" }),
    ).toThrow("WORKER_HEALTH_STALE_SECONDS must be a positive integer");
  });

  it("rejects production proxy trust broader than the single Web proxy hop", () => {
    expect(() =>
      validateEnv({
        ...validProductionEnv,
        API_TRUST_PROXY_HOPS: "2",
      }),
    ).toThrow("API_TRUST_PROXY_HOPS must be exactly 1 in production");
  });

});
