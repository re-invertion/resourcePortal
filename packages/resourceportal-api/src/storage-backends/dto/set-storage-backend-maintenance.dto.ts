import { IsBoolean } from "class-validator";

export class SetStorageBackendMaintenanceDto {
  @IsBoolean()
  enabled!: boolean;
}
