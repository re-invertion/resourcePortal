import { IsBoolean } from "class-validator";

export class UpdateAppGroupNetworkPrivilegeDto {
  @IsBoolean()
  privileged!: boolean;
}
