import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import type { EgressProtocol } from "../network-egress.types";

export class CreateNetworkEgressRuleDto {
  @IsUUID()
  appGroupId!: string;

  @IsString()
  @MaxLength(128)
  destinationCidr!: string;

  @IsOptional()
  @IsIn(["any", "tcp", "udp"])
  protocol?: EgressProtocol;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
