import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import { type NvidiaGpuObservation } from "./nvidia-gpu-observation";

const GPU_UUID = /^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/**
 * Reservation source of truth. The database owns global uniqueness (GPU UUID
 * primary key and unique SingleApp FK); a transaction-wide advisory lock
 * serializes quota validation and assignment decisions between tenants.
 *
 * OBSERVATION MUST NOT release an assigned device. Release requires positive
 * verification that no previous Swarm task or rollback snapshot still has
 * access to the device, and therefore is intentionally not exposed here as
 * a public tenant operation.
 */
@Injectable()
export class NvidiaGpuAllocationService {
  constructor(private readonly prisma: PrismaService) {}

  async listInventory() {
    const devices = await this.prisma.gpuDevice.findMany({
      orderBy: { uuid: "asc" },
      include: {
        remoteLocation: {
          select: { id: true, swarmNodeId: true, hostname: true, status: true, availability: true },
        },
      },
    });
    return devices.map((device) => ({
      uuid: device.uuid,
      vendor: device.vendor,
      model: device.model,
      pciBusId: device.pciBusId,
      memoryBytes: device.memoryBytes.toString(),
      memoryUsedBytes: device.memoryUsedBytes?.toString() ?? null,
      driverVersion: device.driverVersion,
      cudaVersion: device.cudaVersion,
      temperatureCelsius: device.temperatureCelsius,
      utilizationPercent: device.utilizationPercent,
      observedState: device.observedState,
      status: device.allocatedSingleAppId ? "Allocated"
        : device.observedState === "Available" &&
          device.remoteLocation?.status === "Ready" &&
          device.remoteLocation?.availability === "Active" &&
          !!device.lastObservedAt && Date.now() - device.lastObservedAt.getTime() <= 120_000
          ? "Available" : device.observedState === "Unsupported"
            ? "Unsupported" : "Unavailable",
      allocatedSingleAppId: device.allocatedSingleAppId,
      allocationState: device.allocationState,
      allocatedAt: device.allocatedAt,
      lastObservedAt: device.lastObservedAt,
      node: device.remoteLocation,
    }));
  }

  async listForTenant(tenantId: string) {
    const quota = await this.prisma.quota.findUnique({ where: { tenantId }, select: { gpu: true } });
    if (!quota || quota.gpu < 1) return { enabled: false, quota: 0, devices: [] };
    const [inventory, owned] = await Promise.all([
      this.listInventory(),
      this.prisma.gpuDevice.findMany({
        where: { allocatedSingleApp: { appGroup: { tenantId } } },
        select: { uuid: true },
      }),
    ]);
    const myDevices = new Set(owned.map((row) => row.uuid));
    return {
      enabled: true,
      quota: quota.gpu,
      devices: inventory.map(({ allocatedSingleAppId, ...device }) => ({
        ...device,
        status: allocatedSingleAppId === null ? device.status : "Allocated",
        allocatedToThisTenant: myDevices.has(device.uuid),
      })),
    };
  }

  async reserve(tenantId: string, appGroupId: string, singleAppId: string, gpuUuid: string, actor?: AuthenticatedUser) {
    if (!GPU_UUID.test(gpuUuid)) throw new ConflictException("InvalidGpuUuid");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(2026, 10427) IS NULL AS "locked"`;
      const app = await tx.singleApp.findUnique({
        where: { id: singleAppId },
        select: {
          id: true, pendingDeletion: true, gpu: true, desiredReplicas: true,
          appGroupId: true, appGroup: { select: { tenantId: true, status: true } },
        },
      });
      if (!app || app.appGroup.tenantId !== tenantId || app.appGroupId !== appGroupId || app.pendingDeletion || app.appGroup.status === "Deleting") {
        throw new NotFoundException("SingleAppNotFound");
      }
      if (app.desiredReplicas !== 1) {
        throw new ConflictException("DedicatedGpuRequiresOneReplica");
      }
      const quota = await tx.quota.findUnique({ where: { tenantId }, select: { gpu: true } });
      if (!quota || quota.gpu < 1) {
        throw new ForbiddenException("GpuAccessNotEnabled");
      }
      const device = await tx.gpuDevice.findUnique({
        where: { uuid: gpuUuid },
        select: { uuid: true, observedState: true, allocatedSingleAppId: true,
          allocationState: true, lastObservedAt: true, remoteLocation: { select: { status: true, availability: true } } },
      });
      if (!device) throw new NotFoundException("GpuNotFound");
      if (device.allocatedSingleAppId && device.allocatedSingleAppId !== app.id) {
        throw new ConflictException("GpuAlreadyAllocated");
      }
      const currentlyOwned = await tx.gpuDevice.findFirst({
        where: { allocatedSingleAppId: app.id },
        select: { uuid: true },
      });
      if (currentlyOwned && currentlyOwned.uuid !== device.uuid) {
        // Keep the previous allocation until old runtime and rollback paths are fully cleaned.
        throw new ConflictException("GpuReassignmentRequiresDetach");
      }
      if (currentlyOwned && device.allocatedSingleAppId === app.id) {
        if (device.allocationState !== "Allocated") {
          throw new ConflictException("GpuReleaseInProgress");
        }
        // Repair legacy same-owner draft inconsistency atomically.
        if (app.gpu !== 1) {
          await tx.singleApp.update({ where: { id: app.id }, data: { gpu: 1 } });
          await tx.appGroup.update({
            where: { id: app.appGroupId },
            data: { hasPendingChanges: true, runtimeDraftRevision: { increment: 1 } },
          });
        }
        return { uuid: device.uuid, singleAppId: app.id, alreadyAllocated: true };
      }
      if (device.observedState !== "Available" ||
          device.remoteLocation?.status !== "Ready" ||
          device.remoteLocation.availability !== "Active" ||
          !device.lastObservedAt || Date.now() - device.lastObservedAt.getTime() > 120_000) {
        throw new ServiceUnavailableException("GpuRuntimeUnavailable");
      }
      const usage = await tx.gpuDevice.count({
        where: { allocatedSingleApp: { appGroup: { tenantId } } },
      });
      if (usage >= quota.gpu) throw new ConflictException("GpuQuotaExceeded");
      const claimed = await tx.gpuDevice.updateMany({
        where: {
          uuid: gpuUuid, allocatedSingleAppId: null,
          allocationState: "Free", observedState: "Available",
        },
        data: {
          allocatedSingleAppId: app.id,
          allocationState: "Allocated",
          allocatedAt: new Date(),
        },
      });
      if (claimed.count !== 1) throw new ConflictException("GpuAlreadyAllocated");
      await tx.singleApp.update({ where: { id: app.id }, data: { gpu: 1 } });
      await tx.appGroup.update({
        where: { id: app.appGroupId },
        data: { hasPendingChanges: true, runtimeDraftRevision: { increment: 1 } },
      });
      if (actor) {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: tenantId }, select: { name: true },
        });
        await tx.auditLogEntry.create({
          data: {
            tenantId, tenantName: tenant.name, actor: actor.id, actorName: actor.displayName,
            action: 'singleapp.gpu.reserve', resourceType: 'SingleApp', resourceId: app.id,
            result: 'Success', correlationId: randomUUID(),
            changes: { gpuUuid: device.uuid, allocation: 'Exclusive' },
          },
        });
      }
      return { uuid: device.uuid, singleAppId: app.id, alreadyAllocated: false };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  /**
   * Observation is only ever called by a trusted Swarm-node inventory collector.
   * A transient failure is handled by markUnavailable, never deletion.
   */
  async observe(
    remoteLocationId: string,
    observation: NvidiaGpuObservation,
    runtimeReady: boolean,
  ) {
    if (!GPU_UUID.test(observation.uuid)) throw new ConflictException("InvalidGpuUuid");
    const state = runtimeReady ? "Available" : "Unavailable";
    const row = {
      remoteLocationId,
      model: observation.model,
      vendor: observation.vendor,
      pciBusId: observation.pciBusId,
      memoryBytes: BigInt(observation.memoryBytes),
      memoryUsedBytes: observation.memoryUsedBytes === null ? null : BigInt(observation.memoryUsedBytes),
      driverVersion: observation.driverVersion,
      temperatureCelsius: observation.temperatureCelsius,
      utilizationPercent: observation.utilizationPercent,
      observedState: state,
      lastObservedAt: new Date(),
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(2026, 10427) IS NULL AS "locked"`;
      const existing = await tx.gpuDevice.findUnique({
        where: { uuid: observation.uuid },
        select: { remoteLocationId: true, allocatedSingleAppId: true },
      });
      if (existing?.allocatedSingleAppId &&
          existing.remoteLocationId !== remoteLocationId) {
        // Identity moved unexpectedly: preserve the old reservation and
        // invalidate the GPU instead of silently moving an active workload.
        return tx.gpuDevice.update({
          where: { uuid: observation.uuid },
          data: { observedState: "Unavailable" },
        });
      }
      return tx.gpuDevice.upsert({
        where: { uuid: observation.uuid },
        create: { uuid: observation.uuid, ...row },
        update: row,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async markNodeUnavailable(remoteLocationId: string) {
    return this.prisma.gpuDevice.updateMany({
      where: { remoteLocationId },
      data: { observedState: "Unavailable" },
    });
  }

  /**
   * The controller must never call this with client-supplied proof. A trusted
   * deployment reconciler must first verify removal of all containers using
   * the old UUID, including rollback targets. A stopped app is NOT cleanup.
   */
  async releaseAfterVerifiedCleanup(singleAppId: string, verifiedNoWorkloads: boolean) {
    if (!verifiedNoWorkloads) throw new ConflictException("GpuRuntimeCleanupRequired");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(2026, 10427) IS NULL AS "locked"`;
      const device = await tx.gpuDevice.findUnique({
        where: { allocatedSingleAppId: singleAppId },
      });
      if (!device) return { released: false };
      await tx.gpuDevice.update({
        where: { uuid: device.uuid },
        data: { allocatedSingleAppId: null, allocationState: "Free", allocatedAt: null },
      });
      const app = await tx.singleApp.findUnique({
        where: { id: singleAppId }, select: { appGroupId: true },
      });
      if (app) {
        await tx.singleApp.update({ where: { id: singleAppId }, data: { gpu: 0 } });
        await tx.appGroup.update({
          where: { id: app.appGroupId },
          data: { hasPendingChanges: true, runtimeDraftRevision: { increment: 1 } },
        });
      }
      return { released: true, uuid: device.uuid };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}