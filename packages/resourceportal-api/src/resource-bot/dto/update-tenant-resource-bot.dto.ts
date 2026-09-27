import { IsBoolean } from "class-validator";

export class UpdateTenantResourceBotDto {
  @IsBoolean()
  enabled!: boolean;
}
