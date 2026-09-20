import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, RuntimeState } from "@prisma/client";
import { AuthenticatedUser } from "../auth/types";
import {
  insufficientCapacityException,
  platformUnavailableException,
} from "../capacity/capacity-errors";
import {
  CapacityPreflightService,
  type CapacityAdmissionResult,
} from "../capacity/capacity-preflight.service";
import { OperationsRepository } from "../operations/operations.repository";
import type { OperationType } from "../operations/operation.types";
import { PlatformMaintenanceService } from "../platform-maintenance/platform-maintenance.service";
import { PrismaService } from "../prisma/prisma.service";
import { mapAppGroup, mapSingleApp } from "./app-groups.view";

const EXTERNAL_RUNTIME_BLOCKERS = new Set([
  "AppGroupDeleting",
  "AppGroupError",
  "TenantSuspended",
  "BillingSuspended",
  "PlatformMaintenance",
]);

@Injectable()
export class AppGroupRuntimeOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityPreflightService,
    private readonly operations: OperationsRepository,
    private readonly maintenance: PlatformMaintenanceService,
  ) {}

  startAppGroup(tenantId: string, appGroupId: string, actor: AuthenticatedUser) {
    return this.setAppGroupState(tenantId, appGroupId, RuntimeState.Running, actor);
  }

  stopAppGroup(tenantId: string, appGroupId: string, actor: AuthenticatedUser) {
    return this.setAppGroupState(tenantId, appGroupId, RuntimeState.Stopped, actor);
  }

  async restartAppGroup(
    tenantId: string,
    appGroupId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return this.prisma.$transaction(async (tx) => {
      await this.capacity.lockRuntimeMutation(tx);
      const appGroup = await tx.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        include: { singleApps: { orderBy: { createdAt: "asc" } } },
      });
      if (!appGroup) throw new NotFoundException("App Group not found");
      if (appGroup.runtimeState !== RuntimeState.Running) {
        throw new ConflictException("AppGroupNotRunning");
      }
      await this.assertNoActiveDeployment(tx, appGroupId);
      const runnable = appGroup.singleApps.filter(
        (app) =>
          !app.pendingDeletion &&
          app.runtimeState === RuntimeState.Running &&
          app.desiredReplicas > 0,
      );
      if (runnable.length === 0) throw new ConflictException("AppGroupNotRunning");

      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const operation = await this.operations.createOperationInTransaction(tx, {
        type: "APP_GROUP_RESTART",
        tenantId,
        resourceType: "AppGroup",
        resourceId: appGroupId,
        createdBy: actor.id,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        input: { appGroupId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "appgroup.runtime.restart.queued",
          resourceType: "AppGroup",
          resourceId: appGroupId,
          resourceName: appGroup.name,
          result: "Success",
          changes: { operationId: operation.id },
        },
      });
      return {
        appGroup: mapAppGroup(appGroup),
        runtimeApplied: false,
        operationId: operation.id,
      };
    });
  }

  startSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    return this.setSingleAppState(
      tenantId,
      appGroupId,
      singleAppId,
      RuntimeState.Running,
      actor,
    );
  }

  stopSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    return this.setSingleAppState(
      tenantId,
      appGroupId,
      singleAppId,
      RuntimeState.Stopped,
      actor,
    );
  }

  async restartSingleApp(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    actor: AuthenticatedUser,
  ) {
    await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    return this.prisma.$transaction(async (tx) => {
      await this.capacity.lockRuntimeMutation(tx);
      const appGroup = await tx.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        include: { singleApps: { orderBy: { createdAt: "asc" } } },
      });
      if (!appGroup) throw new NotFoundException("App Group not found");
      const singleApp = appGroup.singleApps.find((item) => item.id === singleAppId);
      if (!singleApp) throw new NotFoundException("SingleApp not found");
      if (
        appGroup.runtimeState !== RuntimeState.Running ||
        singleApp.runtimeState !== RuntimeState.Running ||
        singleApp.pendingDeletion ||
        singleApp.desiredReplicas <= 0
      ) {
        throw new ConflictException("SingleAppNotRunning");
      }
      await this.assertNoActiveDeployment(tx, appGroupId);
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const operation = await this.operations.createOperationInTransaction(tx, {
        type: "SINGLE_APP_RESTART",
        tenantId,
        resourceType: "SingleApp",
        resourceId: singleAppId,
        createdBy: actor.id,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        input: { appGroupId, singleAppId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "singleapp.runtime.restart.queued",
          resourceType: "SingleApp",
          resourceId: singleAppId,
          resourceName: singleApp.name,
          result: "Success",
          changes: { appGroupId, operationId: operation.id },
        },
      });
      return {
        singleApp: mapSingleApp(singleApp),
        runtimeApplied: false,
        operationId: operation.id,
      };
    });
  }

  private async setAppGroupState(
    tenantId: string,
    appGroupId: string,
    runtimeState: RuntimeState,
    actor: AuthenticatedUser,
  ) {
    if (runtimeState === RuntimeState.Running) {
      await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.capacity.lockRuntimeMutation(tx);
      const appGroup = await tx.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        include: { singleApps: { orderBy: { createdAt: "asc" } } },
      });
      if (!appGroup) throw new NotFoundException("App Group not found");
      await this.assertNoActiveDeployment(tx, appGroupId);
      if (runtimeState === RuntimeState.Running) {
        this.assertCapacityAdmission(
          await this.capacity.admitRuntimeStart(tx, { appGroupId }),
        );
      }
      const updated = await tx.appGroup.update({
        where: { id: appGroupId },
        data: { runtimeState, updatedBy: actor.id },
        include: { singleApps: { orderBy: { createdAt: "asc" } } },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const type: OperationType =
        runtimeState === RuntimeState.Running ? "APP_GROUP_START" : "APP_GROUP_STOP";
      const operation = await this.operations.createOperationInTransaction(tx, {
        type,
        tenantId,
        resourceType: "AppGroup",
        resourceId: appGroupId,
        createdBy: actor.id,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        input: { appGroupId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action:
            runtimeState === RuntimeState.Running
              ? "appgroup.runtime.start.queued"
              : "appgroup.runtime.stop.queued",
          resourceType: "AppGroup",
          resourceId: appGroupId,
          resourceName: appGroup.name,
          result: "Success",
          changes: {
            previousRuntimeState: appGroup.runtimeState,
            runtimeState,
            operationId: operation.id,
          },
        },
      });
      return {
        appGroup: mapAppGroup(updated),
        runtimeApplied: false,
        operationId: operation.id,
      };
    });
  }

  private async setSingleAppState(
    tenantId: string,
    appGroupId: string,
    singleAppId: string,
    runtimeState: RuntimeState,
    actor: AuthenticatedUser,
  ) {
    if (runtimeState === RuntimeState.Running) {
      await this.assertExternalRuntimeUnblocked(tenantId, appGroupId);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.capacity.lockRuntimeMutation(tx);
      const appGroup = await tx.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        include: { singleApps: { orderBy: { createdAt: "asc" } } },
      });
      if (!appGroup) throw new NotFoundException("App Group not found");
      const current = appGroup.singleApps.find((item) => item.id === singleAppId);
      if (!current) throw new NotFoundException("SingleApp not found");
      if (current.pendingDeletion) {
        throw new ConflictException("SingleApp is pending deletion");
      }
      await this.assertNoActiveDeployment(tx, appGroupId);
      if (runtimeState === RuntimeState.Running) {
        this.assertCapacityAdmission(
          await this.capacity.admitRuntimeStart(tx, { appGroupId, singleAppId }),
        );
      }
      const updated = await tx.singleApp.update({
        where: { id: singleAppId },
        data: { runtimeState, updatedBy: actor.id },
      });
      await tx.appGroup.update({ where: { id: appGroupId }, data: { updatedBy: actor.id } });
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true },
      });
      const type: OperationType =
        runtimeState === RuntimeState.Running ? "SINGLE_APP_START" : "SINGLE_APP_STOP";
      const operation = await this.operations.createOperationInTransaction(tx, {
        type,
        tenantId,
        resourceType: "SingleApp",
        resourceId: singleAppId,
        createdBy: actor.id,
        createdByEmail: actor.email,
        createdByDisplayName: actor.displayName,
        input: { appGroupId, singleAppId },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action:
            runtimeState === RuntimeState.Running
              ? "singleapp.runtime.start.queued"
              : "singleapp.runtime.stop.queued",
          resourceType: "SingleApp",
          resourceId: singleAppId,
          resourceName: current.name,
          result: "Success",
          changes: {
            appGroupId,
            previousRuntimeState: current.runtimeState,
            runtimeState,
            operationId: operation.id,
          },
        },
      });
      return {
        singleApp: mapSingleApp(updated),
        runtimeApplied: false,
        operationId: operation.id,
      };
    });
  }

  private async assertExternalRuntimeUnblocked(tenantId: string, appGroupId: string) {
    const [appGroup, maintenance] = await Promise.all([
      this.prisma.appGroup.findFirst({
        where: { id: appGroupId, tenantId },
        include: { tenant: { include: { billing: true } } },
      }),
      this.maintenance.getState(),
    ]);
    if (!appGroup) throw new NotFoundException("App Group not found");
    const blockers = [
      appGroup.status === "Deleting" ? "AppGroupDeleting" : undefined,
      appGroup.status === "Error" ? "AppGroupError" : undefined,
      appGroup.tenant.status === "Suspended" ? "TenantSuspended" : undefined,
      appGroup.tenant.billing?.balance.lte(0) ? "BillingSuspended" : undefined,
      maintenance.enabled ? "PlatformMaintenance" : undefined,
    ].filter((item): item is string => item !== undefined && EXTERNAL_RUNTIME_BLOCKERS.has(item));
    if (blockers.length > 0) {
      throw new ConflictException({ code: "RuntimeBlocked", blockers });
    }
  }

  private async assertNoActiveDeployment(tx: Prisma.TransactionClient, appGroupId: string) {
    const active = await tx.appGroupDeployment.findFirst({
      where: {
        appGroupId,
        status: { in: ["Pending", "Deploying", "RollingBack"] },
      },
      select: { status: true },
    });
    if (active) {
      throw new ConflictException({
        code: "AppGroupBusy",
        message: `AppGroup has active deployment: ${active.status}`,
      });
    }
  }

  private assertCapacityAdmission(result: CapacityAdmissionResult) {
    if (result.success) return;
    if (result.errorCode === "InsufficientCapacity") {
      throw insufficientCapacityException(result.message);
    }
    throw platformUnavailableException(result.message);
  }
}
