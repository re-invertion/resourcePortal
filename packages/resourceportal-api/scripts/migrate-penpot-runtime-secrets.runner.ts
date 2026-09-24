import { SecretType, UserStatus } from "@prisma/client";
import { NestFactory } from "@nestjs/core";
import crypto from "node:crypto";
import {
  buildPenpotRuntimeMigrationPlan,
  PENPOT_DATABASE_SECRET_NAME,
  PENPOT_DATABASE_SECRET_TARGET,
  PENPOT_SECRET_KEY_SECRET_NAME,
  PENPOT_SECRET_KEY_TARGET,
  type PenpotRuntimeApp,
} from "../src/migrations/penpot-runtime-secrets";
import { AppModule } from "../src/app.module";
import { AppGroupsService } from "../src/app-groups/app-groups.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SecretStorageService } from "../src/security/secret-storage.service";

const TERMINAL_DEPLOYMENT_STATUSES = new Set([
  "Succeeded",
  "Failed",
  "RolledBack",
  "RollbackFailed",
]);

export type PenpotRuntimeSecretMigrationOptions = {
  appGroupId: string;
  apply: boolean;
};

export async function runPenpotRuntimeSecretMigration(
  options: PenpotRuntimeSecretMigrationOptions,
) {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const prisma = app.get(PrismaService);
    const appGroups = app.get(AppGroupsService);
    const secretStorage = app.get(SecretStorageService);
    const state = await loadState(prisma, options.appGroupId);
    const plan = buildPenpotRuntimeMigrationPlan(state.apps);

    if (state.group.hasPendingChanges) {
      throw new Error(
        "AppGroup already has pending changes; refusing to mix migration with an existing draft",
      );
    }
    if (state.activeDeployment) {
      throw new Error(
        `AppGroup has active deployment: ${state.activeDeployment.status}`,
      );
    }
    if (state.existingSecrets.length > 0) {
      throw new Error(
        "AppGroup already contains Secrets; this one-shot migration requires a clean Secret set",
      );
    }

    console.log(
      JSON.stringify({
        status: options.apply ? "applying" : "dry-run-ok",
        appGroupId: state.group.id,
        currentDeploymentVersion: state.group.currentDeploymentVersion,
        appsToUpdate: plan.updates.map((update) => update.appName),
        secretsToCreate: [
          PENPOT_DATABASE_SECRET_NAME,
          PENPOT_SECRET_KEY_SECRET_NAME,
        ],
        attachmentsToCreate: 4,
      }),
    );

    if (!options.apply) return;

    const databaseSecretId = crypto.randomUUID();
    const secretKeyId = crypto.randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.secret.createMany({
        data: [
          {
            id: databaseSecretId,
            appGroupId: state.group.id,
            name: PENPOT_DATABASE_SECRET_NAME,
            description:
              "Penpot PostgreSQL credential migrated from runtime environment",
            type: SecretType.Text,
            valueVersion: 1,
            keyVersion: 1,
            valueCiphertext: secretStorage.seal(
              Buffer.from(plan.databasePassword, "utf8"),
            ),
            storagePath: null,
            createdBy: state.actor.id,
            updatedBy: state.actor.id,
          },
          {
            id: secretKeyId,
            appGroupId: state.group.id,
            name: PENPOT_SECRET_KEY_SECRET_NAME,
            description:
              "Penpot application secret key migrated from runtime environment",
            type: SecretType.Text,
            valueVersion: 1,
            keyVersion: 1,
            valueCiphertext: secretStorage.seal(
              Buffer.from(plan.secretKey, "utf8"),
            ),
            storagePath: null,
            createdBy: state.actor.id,
            updatedBy: state.actor.id,
          },
        ],
      });

      const backend = state.apps.find(
        (item) => item.name === "penpot-backend",
      )!;
      const exporter = state.apps.find(
        (item) => item.name === "penpot-exporter",
      )!;
      const postgres = state.apps.find(
        (item) => item.name === "penpot-postgres",
      )!;
      await tx.secretAttachment.createMany({
        data: [
          {
            secretId: databaseSecretId,
            singleAppId: backend.id,
            targetName: PENPOT_DATABASE_SECRET_TARGET,
            createdBy: state.actor.id,
          },
          {
            secretId: databaseSecretId,
            singleAppId: postgres.id,
            targetName: PENPOT_DATABASE_SECRET_TARGET,
            createdBy: state.actor.id,
          },
          {
            secretId: secretKeyId,
            singleAppId: backend.id,
            targetName: PENPOT_SECRET_KEY_TARGET,
            createdBy: state.actor.id,
          },
          {
            secretId: secretKeyId,
            singleAppId: exporter.id,
            targetName: PENPOT_SECRET_KEY_TARGET,
            createdBy: state.actor.id,
          },
        ],
      });

      for (const update of plan.updates) {
        await tx.singleApp.update({
          where: { id: update.appId },
          data: {
            environment: update.environment,
            entrypoint: update.entrypoint,
            command: update.command,
            updatedBy: state.actor.id,
          },
        });
      }

      await tx.appGroup.update({
        where: { id: state.group.id },
        data: {
          hasPendingChanges: true,
          runtimeDraftRevision: { increment: 1 },
          updatedBy: state.actor.id,
        },
      });

      await tx.auditLogEntry.create({
        data: {
          tenantId: state.group.tenantId,
          tenantName: state.group.tenant.name,
          actor: state.actor.id,
          actorName: state.actor.displayName,
          action: "appgroup.runtime-secrets.migrate",
          resourceType: "AppGroup",
          resourceId: state.group.id,
          resourceName: state.group.name,
          result: "Success",
          changes: {
            migration: "penpot-environment-to-resourceportal-secrets",
            secretNames: [
              PENPOT_DATABASE_SECRET_NAME,
              PENPOT_SECRET_KEY_SECRET_NAME,
            ],
            appNames: plan.updates.map((update) => update.appName),
            sensitiveEnvironmentValuesRemoved: 4,
          },
        },
      });
    });

    const deployment = await appGroups.deployAppGroup(
      state.group.tenantId,
      state.group.id,
      {
        note: "Migrate Penpot runtime credentials to ResourcePortal Secrets",
      },
      `penpot-runtime-secret-migration-v1-${state.group.id}`,
      state.actor,
    );

    const terminal = await waitForDeployment(prisma, deployment.id);
    if (terminal.status !== "Succeeded") {
      throw new Error(
        `Penpot Secret migration deployment ended with ${terminal.status}${terminal.errorCode ? ` (${terminal.errorCode})` : ""}`,
      );
    }

    console.log(
      JSON.stringify({
        status: "succeeded",
        appGroupId: state.group.id,
        deploymentId: terminal.id,
        version: terminal.version,
      }),
    );
  } finally {
    await app.close();
  }
}

async function loadState(prisma: PrismaService, appGroupId: string) {
  const group = await prisma.appGroup.findUnique({
    where: { id: appGroupId },
    include: { tenant: { select: { name: true } } },
  });
  if (!group) throw new Error("AppGroup not found");

  const actorIds = [group.updatedBy, group.createdBy].filter((value) =>
    /^[0-9a-fA-F-]{36}$/.test(value),
  );
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds }, status: UserStatus.Active },
    select: { id: true, email: true, displayName: true, status: true },
  });
  const actor = actorIds
    .map((id) => actors.find((candidate) => candidate.id === id))
    .find((candidate) => candidate !== undefined);
  if (!actor) throw new Error("No active AppGroup actor is available");

  const [rows, existingSecrets, activeDeployment] = await Promise.all([
    prisma.singleApp.findMany({
      where: { appGroupId, pendingDeletion: false },
      select: {
        id: true,
        name: true,
        environment: true,
        entrypoint: true,
        command: true,
      },
    }),
    prisma.secret.findMany({
      where: { appGroupId },
      select: { id: true, name: true },
    }),
    prisma.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        status: { in: ["Pending", "Deploying", "RollingBack"] },
      },
      select: { id: true, status: true },
    }),
  ]);

  const apps: PenpotRuntimeApp[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    environment: stringRecord(row.environment, row.name),
    entrypoint: row.entrypoint,
    command: row.command,
  }));

  return { group, actor, apps, existingSecrets, activeDeployment };
}

async function waitForDeployment(prisma: PrismaService, deploymentId: string) {
  const timeoutMs = Number.parseInt(
    process.env.PENPOT_SECRET_MIGRATION_TIMEOUT_MS ?? "600000",
    10,
  );
  const deadline = Date.now() + Math.max(30000, timeoutMs || 600000);

  while (Date.now() < deadline) {
    const deployment = await prisma.appGroupDeployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, version: true, status: true, errorCode: true },
    });
    if (!deployment) throw new Error("Migration deployment disappeared");
    if (TERMINAL_DEPLOYMENT_STATUSES.has(deployment.status)) return deployment;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting for Penpot Secret migration deployment");
}

function stringRecord(value: unknown, appName: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid environment object on ${appName}`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`Non-string environment value on ${appName}:${key}`);
    }
    result[key] = item;
  }
  return result;
}
