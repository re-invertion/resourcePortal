import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { PrismaService } from "../prisma/prisma.service";
import {
  isCostIncreasingSingleAppUpdate,
  isCostIncreasingVolumeResize,
  SingleAppCostUpdate,
} from "./billing-preflight";
import { BillingService } from "./billing.service";

type PreflightParams = {
  tenantId?: string;
  singleAppId?: string;
  volumeId?: string;
};

type PreflightBody = SingleAppCostUpdate & { sizeBytes?: number };
type PreflightRequest = FastifyRequest<{
  Params: PreflightParams;
  Body: PreflightBody;
}>;

@Injectable()
export class BillingPreflightGuard implements CanActivate {
  constructor(
    private readonly billing: BillingService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== "http") {
      return true;
    }

    const request = context.switchToHttp().getRequest<PreflightRequest>();
    const route = request.routeOptions.url ?? "";
    const method = request.method.toUpperCase();
    const params = request.params;

    if (!params.tenantId) {
      return true;
    }

    if (
      method === "POST" &&
      (route.endsWith("/:appGroupId/single-apps") ||
        route.endsWith("/:appGroupId/runtime/start") ||
        route.endsWith("/:appGroupId/single-apps/:singleAppId/runtime/start") ||
        route === "/tenants/:tenantId/volumes")
    ) {
      await this.billing.assertActivePriceList();
      return true;
    }

    if (
      method === "PATCH" &&
      route.endsWith("/:appGroupId/single-apps/:singleAppId") &&
      params.singleAppId
    ) {
      const existing = await this.prisma.singleApp.findFirst({
        where: {
          id: params.singleAppId,
          appGroup: { tenantId: params.tenantId },
        },
        select: {
          cpu: true,
          memoryBytes: true,
          gpu: true,
          desiredReplicas: true,
        },
      });
      if (
        existing &&
        isCostIncreasingSingleAppUpdate(existing, request.body ?? {})
      ) {
        await this.billing.assertActivePriceList();
      }
      return true;
    }

    if (
      method === "PATCH" &&
      route === "/tenants/:tenantId/volumes/:volumeId/resize" &&
      params.volumeId
    ) {
      const existing = await this.prisma.volume.findFirst({
        where: { id: params.volumeId, tenantId: params.tenantId },
        select: { sizeBytes: true },
      });
      const requested = request.body?.sizeBytes;
      if (
        existing &&
        requested !== undefined &&
        isCostIncreasingVolumeResize(existing.sizeBytes, requested)
      ) {
        await this.billing.assertActivePriceList();
      }
    }

    return true;
  }
}
