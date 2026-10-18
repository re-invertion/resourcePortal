import {
  ArrayMaxSize,
  IsArray,
  IsIP,
  IsOptional,
  IsString,
  MaxLength,
  IsInt,
  Min,
  Max,
} from "class-validator";

export class GateHeartbeatDto {
  @IsArray()
  @ArrayMaxSize(16)
  @IsIP(4, { each: true })
  lanAddresses!: string[];

  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  lanCidrs!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1)
  discoveryRelayVersion?: number;
}
