import { describe, expect, it } from "vitest";
import { buildPenpotRuntimeMigrationPlan } from "./penpot-runtime-secrets";

const baseApps = [
  {
    id: "backend",
    name: "penpot-backend",
    environment: {
      PENPOT_DATABASE_PASSWORD: "db-secret",
      PENPOT_SECRET_KEY: "app-secret",
      PENPOT_PUBLIC_URI: "https://penpot.example.test",
    },
    entrypoint: null,
    command: [],
  },
  {
    id: "exporter",
    name: "penpot-exporter",
    environment: {
      PENPOT_SECRET_KEY: "app-secret",
      PENPOT_INTERNAL_URI: "http://penpot-backend:6060",
    },
    entrypoint: null,
    command: [],
  },
  {
    id: "postgres",
    name: "penpot-postgres",
    environment: {
      POSTGRES_PASSWORD: "db-secret",
      POSTGRES_DB: "penpot",
    },
    entrypoint: null,
    command: [],
  },
];

describe("Penpot runtime Secret migration plan", () => {
  it("moves sensitive runtime values out of environment and installs file-backed wrappers", () => {
    const plan = buildPenpotRuntimeMigrationPlan(baseApps);
    expect(plan.databasePassword).toBe("db-secret");
    expect(plan.secretKey).toBe("app-secret");

    const backend = plan.updates.find(
      (item) => item.appName === "penpot-backend",
    )!;
    const exporter = plan.updates.find(
      (item) => item.appName === "penpot-exporter",
    )!;
    const postgres = plan.updates.find(
      (item) => item.appName === "penpot-postgres",
    )!;

    expect(backend.environment).not.toHaveProperty("PENPOT_DATABASE_PASSWORD");
    expect(backend.environment).not.toHaveProperty("PENPOT_SECRET_KEY");
    expect(backend.environment.PENPOT_PUBLIC_URI).toBe(
      "https://penpot.example.test",
    );
    expect(backend.entrypoint).toBe("/bin/sh");
    expect(backend.command.join(" ")).toContain(
      "/run/secrets/penpot_secret_key",
    );
    expect(backend.command.join(" ")).toContain(
      "/run/secrets/penpot_database_password",
    );

    expect(exporter.environment).not.toHaveProperty("PENPOT_SECRET_KEY");
    expect(exporter.command.join(" ")).toContain("exec node app.js");

    expect(postgres.environment).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(postgres.environment.POSTGRES_DB).toBe("penpot");
    expect(postgres.command.join(" ")).toContain(
      "exec docker-entrypoint.sh postgres",
    );
  });

  it("refuses mismatched database passwords", () => {
    const apps = structuredClone(baseApps);
    apps[0].environment.PENPOT_DATABASE_PASSWORD = "different";
    expect(() => buildPenpotRuntimeMigrationPlan(apps)).toThrow(
      /password mismatch/,
    );
  });

  it("refuses mismatched Penpot secret keys", () => {
    const apps = structuredClone(baseApps);
    apps[1].environment.PENPOT_SECRET_KEY = "different";
    expect(() => buildPenpotRuntimeMigrationPlan(apps)).toThrow(
      /secret-key mismatch/,
    );
  });
});
