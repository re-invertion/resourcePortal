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
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        AUTH_MODE: "unknown",
      }),
    ).toThrow("AUTH_MODE must be one of");
  });

  it("requires OIDC settings when OIDC auth is enabled", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        AUTH_MODE: "oidc",
      }),
    ).toThrow(
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
    const env = {
      ...validBaseEnv,
      TRAEFIK_CERT_RESOLVER: "letsencrypt-prod_1",
    };

    expect(validateEnv(env)).toBe(env);
  });

  it("rejects malformed Traefik certificate resolver names", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        TRAEFIK_CERT_RESOLVER: "let's encrypt",
      }),
    ).toThrow(
      "TRAEFIK_CERT_RESOLVER must contain only letters, numbers, underscore, or hyphen",
    );
  });

  it("requires secure cookies and a non-default internal token in production", () => {
    expect(() =>
      validateEnv({
        ...validBaseEnv,
        NODE_ENV: "production",
      }),
    ).toThrow(
      "AUTH_COOKIE_SECURE must be true in production; RESOURCE_ENCRYPTION_KEY is required; INTERNAL_WORKER_TOKEN must be changed in production",
    );
  });

  it("accepts production when hardening settings are present", () => {
    const env = {
      ...validBaseEnv,
      AUTH_COOKIE_SECURE: "true",
      INTERNAL_WORKER_TOKEN: "changed-production-token",
      NODE_ENV: "production",
      RESOURCE_ENCRYPTION_KEY:
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    };

    expect(validateEnv(env)).toBe(env);
  });
});
