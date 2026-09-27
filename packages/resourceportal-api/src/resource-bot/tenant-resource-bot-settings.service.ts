import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthenticatedUser } from "../auth/types";
import { PrismaService } from "../prisma/prisma.service";
import type { UpdateTenantResourceBotDto } from "./dto/update-tenant-resource-bot.dto";
import { PlatformResourceBotService } from "./platform-resource-bot.service";
import { ResourceBotBillingService } from "./resource-bot-billing.service";

@Injectable()
export class TenantResourceBotSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformResourceBotService,
    private readonly billing: ResourceBotBillingService,
  ) {}

  async getSettings(tenantId: string) {
    await this.ensureTenantExists(tenantId);
    const settings = await this.prisma.tenantResourceBotSettings.findUnique({
      where: { tenantId },
    });
    return {
      enabled: settings?.enabled ?? true,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  async updateSettings(
    tenantId: string,
    dto: UpdateTenantResourceBotDto,
    actor: AuthenticatedUser,
  ) {
    const tenant = await this.ensureTenantExists(tenantId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const settings = await tx.tenantResourceBotSettings.upsert({
        where: { tenantId },
        create: {
          tenantId,
          enabled: dto.enabled,
          updatedBy: actor.id,
        },
        update: {
          enabled: dto.enabled,
          updatedBy: actor.id,
        },
      });
      await tx.auditLogEntry.create({
        data: {
          tenantId,
          tenantName: tenant.name,
          actor: actor.id,
          actorName: actor.displayName,
          action: "tenant.resourcebot.settings.update",
          resourceType: "TenantResourceBotSettings",
          resourceId: tenantId,
          resourceName: "ResourceBot",
          result: "Success",
          correlationId: randomUUID(),
          changes: { enabled: settings.enabled },
        },
      });
      return settings;
    });
    return {
      enabled: updated.enabled,
      updatedAt: updated.updatedAt,
    };
  }

  async getStatus(tenantId: string) {
    const [tenant, settings, platform, billing] = await Promise.all([
      this.ensureTenantExists(tenantId),
      this.prisma.tenantResourceBotSettings.findUnique({
        where: { tenantId },
        select: { enabled: true },
      }),
      this.platform.getRuntimeState(),
      this.prisma.billingAccount.findUnique({
        where: { tenantId },
        select: { balance: true },
      }),
    ]);
    const tenantEnabled = settings?.enabled ?? true;
    const billingActive = Boolean(billing && billing.balance.gt(0));
    const priceAvailable = platform.available
      ? await this.billing
          .getActivePrice(platform.provider, platform.generationModel)
          .then(() => true)
          .catch(() => false)
      : false;
    return {
      tenantId: tenant.id,
      tenantEnabled,
      platformEnabled: platform.enabled,
      platformConfigured: platform.configured,
      platformAvailable: platform.available,
      billingActive,
      priceAvailable,
      available:
        tenantEnabled &&
        platform.available &&
        priceAvailable &&
        billingActive,
      reason: !tenantEnabled
        ? "ResourceBotDisabled"
        : !platform.available
          ? "ResourceBotPlatformNotConfigured"
          : !priceAvailable
            ? "ResourceBotPriceUnavailable"
            : !billingActive
              ? "ResourceBotBillingSuspended"
              : null,
      provider: platform.provider,
      generationModel: platform.generationModel,
      lastValidatedAt: platform.lastValidatedAt,
    };
  }

  async assertEnabled(tenantId: string) {
    const settings = await this.prisma.tenantResourceBotSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    if (settings?.enabled === false) {
      throw new ForbiddenException({
        code: "ResourceBotDisabled",
        message: "ResourceBot is disabled for this tenant",
      });
    }
  }

  private async ensureTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }
}
