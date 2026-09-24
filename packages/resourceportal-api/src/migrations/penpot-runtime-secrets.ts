export type PenpotRuntimeApp = {
  id: string;
  name: string;
  environment: Record<string, string>;
  entrypoint: string | null;
  command: string[];
};

export type PenpotRuntimeMigrationPlan = {
  databasePassword: string;
  secretKey: string;
  updates: Array<{
    appId: string;
    appName: string;
    environment: Record<string, string>;
    entrypoint: string;
    command: string[];
  }>;
};

export const PENPOT_DATABASE_SECRET_NAME = "penpot-database-password";
export const PENPOT_SECRET_KEY_SECRET_NAME = "penpot-secret-key";
export const PENPOT_DATABASE_SECRET_TARGET = "penpot_database_password";
export const PENPOT_SECRET_KEY_TARGET = "penpot_secret_key";

const BACKEND_WRAPPER = [
  "-ec",
  'export PENPOT_SECRET_KEY="$(cat /run/secrets/penpot_secret_key)"; export PENPOT_DATABASE_PASSWORD="$(cat /run/secrets/penpot_database_password)"; exec /bin/bash run.sh',
];
const EXPORTER_WRAPPER = [
  "-ec",
  'export PENPOT_SECRET_KEY="$(cat /run/secrets/penpot_secret_key)"; exec node app.js',
];
const POSTGRES_WRAPPER = [
  "-ec",
  "export POSTGRES_PASSWORD_FILE=/run/secrets/penpot_database_password; exec docker-entrypoint.sh postgres",
];

export function buildPenpotRuntimeMigrationPlan(
  apps: PenpotRuntimeApp[],
): PenpotRuntimeMigrationPlan {
  const byName = new Map(apps.map((app) => [app.name, app]));
  const backend = requiredApp(byName, "penpot-backend");
  const exporter = requiredApp(byName, "penpot-exporter");
  const postgres = requiredApp(byName, "penpot-postgres");

  const databasePassword = requiredValue(
    postgres.environment,
    "POSTGRES_PASSWORD",
    postgres.name,
  );
  const backendDatabasePassword = requiredValue(
    backend.environment,
    "PENPOT_DATABASE_PASSWORD",
    backend.name,
  );
  const secretKey = requiredValue(
    backend.environment,
    "PENPOT_SECRET_KEY",
    backend.name,
  );
  const exporterSecretKey = requiredValue(
    exporter.environment,
    "PENPOT_SECRET_KEY",
    exporter.name,
  );

  if (databasePassword !== backendDatabasePassword) {
    throw new Error("Penpot backend/PostgreSQL database password mismatch");
  }
  if (secretKey !== exporterSecretKey) {
    throw new Error("Penpot backend/exporter secret-key mismatch");
  }

  return {
    databasePassword,
    secretKey,
    updates: [
      {
        appId: backend.id,
        appName: backend.name,
        environment: withoutKeys(backend.environment, [
          "PENPOT_DATABASE_PASSWORD",
          "PENPOT_SECRET_KEY",
        ]),
        entrypoint: "/bin/sh",
        command: BACKEND_WRAPPER,
      },
      {
        appId: exporter.id,
        appName: exporter.name,
        environment: withoutKeys(exporter.environment, ["PENPOT_SECRET_KEY"]),
        entrypoint: "/bin/sh",
        command: EXPORTER_WRAPPER,
      },
      {
        appId: postgres.id,
        appName: postgres.name,
        environment: withoutKeys(postgres.environment, ["POSTGRES_PASSWORD"]),
        entrypoint: "/bin/sh",
        command: POSTGRES_WRAPPER,
      },
    ],
  };
}

function requiredApp(
  apps: Map<string, PenpotRuntimeApp>,
  name: string,
): PenpotRuntimeApp {
  const app = apps.get(name);
  if (!app) throw new Error(`Required Penpot app is missing: ${name}`);
  return app;
}

function requiredValue(
  environment: Record<string, string>,
  key: string,
  appName: string,
) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required Penpot runtime value is missing: ${appName}:${key}`,
    );
  }
  return value;
}

function withoutKeys(
  source: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const result = { ...source };
  for (const key of keys) delete result[key];
  return result;
}
