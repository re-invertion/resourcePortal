import { IsBoolean } from "class-validator";

export class UpdateNetworkEgressPolicyDto {
  @IsBoolean()
  enabled!: boolean;
}
