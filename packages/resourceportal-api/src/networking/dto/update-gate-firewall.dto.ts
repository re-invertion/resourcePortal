import { IsBoolean, IsInt, Min } from "class-validator";

export class UpdateGateFirewallDto {
  @IsBoolean()
  allowLanToRp!: boolean;

  @IsBoolean()
  allowRpToLan!: boolean;

  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
