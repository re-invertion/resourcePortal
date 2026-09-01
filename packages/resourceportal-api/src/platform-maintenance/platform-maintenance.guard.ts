import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ALLOW_DURING_PLATFORM_MAINTENANCE_KEY } from "./platform-maintenance.constants";
import { PlatformMaintenanceService } from "./platform-maintenance.service";

@Injectable()
export class PlatformMaintenanceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly maintenance: PlatformMaintenanceService,
  ) {}

  async canActivate(context: ExecutionContext) {
    if (context.getType() !== "http") {
      return true;
    }

    const allowDuringMaintenance = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_PLATFORM_MAINTENANCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowDuringMaintenance) {
      return true;
    }

    const state = await this.maintenance.getState();
    if (!state.enabled) {
      return true;
    }

    throw new ServiceUnavailableException({
      statusCode: 503,
      code: "PLATFORM_MAINTENANCE",
      message: "Resource Portal is in platform maintenance mode",
      reason: state.reason,
    });
  }
}
