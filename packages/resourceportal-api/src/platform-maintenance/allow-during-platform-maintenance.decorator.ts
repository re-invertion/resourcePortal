import { SetMetadata } from "@nestjs/common";
import { ALLOW_DURING_PLATFORM_MAINTENANCE_KEY } from "./platform-maintenance.constants";

export const AllowDuringPlatformMaintenance = () =>
  SetMetadata(ALLOW_DURING_PLATFORM_MAINTENANCE_KEY, true);
