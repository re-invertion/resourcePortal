import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from "@nestjs/common";
import { Prisma, RuntimeState, TenantStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { computeMinuteCost, storageMinuteCost } from "./billing-math";
import { BillingService } from "./billing.service";
import { BillingUsageService } from "./billing-usage.service";
import {
  billedReplicaCount,
  effectiveReplicaCount,
  reconciliationPeriods,
} from "./billing-worker.logic";

const WORKER_STATE_ID = "minute-usage";
const MAX_BACKFILL_PERIODS = 10;

@Injectable()
export class BillingWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BillingWorkerService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly usageLedger: BillingUsageService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.NODE_ENV === "test") {
      return;
    }

    void this.reconcileClosedPeriods().catch((error: unknown) => {
      this.logger.warn(`Initial billing reconciliation failed: ${this.errorMessage(error)}`);
    });
    this.timer = setInterval(() => {
      void this.reconcileClosedPeriods().catch((error: unknown) => {
        this.logger.warn(`Billing reconciliation failed: ${this.errorMessage(error)}`);
      });
    }, 60_000);
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async reconcileClosedPeriods(now = new Date()) {
    if (this.running) {
      return { skipped: true, periodsProcessed: 0 };
    }

    this.running = true;
    try {
      const state = await this.prisma.$queryRaw<
        Array<{ lastCompletedPeriodEnd: Date | null }>
      >`
        SELECT "lastCompletedPeriodEnd"
        FROM "BillingWorkerState"
        WHERE "id" = ${WORKER_STATE_ID}
      `;
      const periods = reconciliationPeriods({
        now,
        lastCompletedPeriodEnd: state[0]?.lastCompletedPeriodEnd ?? null,
        maxPeriods: MAX_BACKFILL_PERIODS,
      });

      for (const period of periods) {
        await this.reconcilePeriod(period.periodStart, period.periodEnd);
        await this.prisma.$executeRaw`
          INSERT INTO "BillingWorkerState" ("id", "lastCompletedPeriodEnd", "updatedAt")
          VALUES (${WORKER_STATE_ID}, ${period.periodEnd}, CURRENT_TIMESTAMP)
          ON CONFLICT ("id") DO UPDATE
          SET "lastCompletedPeriodEnd" = EXCLUDED."lastCompletedPeriodEnd",
              "updatedAt" = CURRENT_TIMESTAMP
        `;
      }

      return { skipped: false, periodsProcessed: periods.length };
    } finally {
      this.running = false;
    }
  }

  async reconcilePeriod(periodStart: Date, periodEnd: Date) {
    const priceList = await this.billing.assertActivePriceList(periodStart);
    const accounts = await this.prisma.billingAccount.findMany();
    const accountsByTenant = new Map(
      accounts.map((account) => [account.tenantId, account] as const),
    );

    const apps = await this.prisma.singleApp.findMany({
      include: {
        appGroup: {
          select: {
            id: true,
            tenantId: true,
            runtimeState: true,
            tenant: { select: { status: true } },
          },
        },
      },
    });

    for (const app of apps) {
      const account = accountsByTenant.get(app.appGroup.tenantId);
      if (!account) continue;

      const effectiveReplicas = effectiveReplicaCount({
        desiredReplicas: app.desiredReplicas,
        appGroupRunning:
          app.appGroup.runtimeState === RuntimeState.Running &&
          app.appGroup.tenant.status === TenantStatus.Active,
        singleAppRunning: app.runtimeState === RuntimeState.Running,
        billingActive: account.balance.gt(0),
        pendingDeletion: app.pendingDeletion,
      });
      const billedReplicas = billedReplicaCount(
        app.actualReplicas,
        effectiveReplicas,
      );
      const theoreticalCost = computeMinuteCost({
        billedReplicas,
        cpu: app.cpu,
        memoryBytes: app.memoryBytes,
        gpu: app.gpu,
        cpuCreditsPerVcpuHour: priceList.cpuCreditsPerVcpuHour,
        memoryCreditsPerGbHour: priceList.memoryCreditsPerGbHour,
        gpuCreditsPerGpuHour: priceList.gpuCreditsPerGpuHour,
      });

      await this.usageLedger.recordUsageCharge({
        tenantId: app.appGroup.tenantId,
        resourceType: "SingleApp",
        resourceId: app.id,
        appGroupId: app.appGroup.id,
        periodStart,
        periodEnd,
        priceListVersionId: priceList.id,
        theoreticalCost,
        allowDebt: false,
        usage: {
          appGroupId: app.appGroup.id,
          desiredReplicas: app.desiredReplicas,
          actualReplicas: app.actualReplicas,
          effectiveReplicas,
          billedReplicas,
          cpuPerReplica: app.cpu.toString(),
          memoryBytesPerReplica: app.memoryBytes.toString(),
          gpuPerReplica: app.gpu,
          rates: {
            cpuPerVcpuHourCredits: priceList.cpuCreditsPerVcpuHour.toString(),
            memoryPerGbHourCredits: priceList.memoryCreditsPerGbHour.toString(),
            gpuPerUnitHourCredits: priceList.gpuCreditsPerGpuHour.toString(),
          },
        } satisfies Prisma.InputJsonObject,
      });
    }

    const volumes = await this.prisma.volume.findMany({
      select: { id: true, tenantId: true, sizeBytes: true },
    });
    for (const volume of volumes) {
      if (!accountsByTenant.has(volume.tenantId)) continue;

      const theoreticalCost = storageMinuteCost({
        sizeBytes: volume.sizeBytes,
        storageCreditsPerGbHour: priceList.storageCreditsPerGbHour,
      });
      await this.usageLedger.recordUsageCharge({
        tenantId: volume.tenantId,
        resourceType: "Volume",
        resourceId: volume.id,
        periodStart,
        periodEnd,
        priceListVersionId: priceList.id,
        theoreticalCost,
        allowDebt: true,
        usage: {
          sizeBytes: volume.sizeBytes.toString(),
          storagePerGbHourCredits: priceList.storageCreditsPerGbHour.toString(),
        } satisfies Prisma.InputJsonObject,
      });
    }

    return {
      periodStart,
      periodEnd,
      priceListVersion: priceList.version,
      computeResources: apps.length,
      storageResources: volumes.length,
    };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
