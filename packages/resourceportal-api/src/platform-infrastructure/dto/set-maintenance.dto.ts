import { IsBoolean } from "class-validator";

export class SetRemoteLocationMaintenanceDto {
  @IsBoolean()
  enabled!: boolean;
}
