import {
  ArrayMaxSize,
  IsArray,
  IsIP,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class GateEnrollDto {
  @IsArray()
  @ArrayMaxSize(16)
  @IsIP(4, { each: true })
  lanAddresses!: string[];

  @IsString()
  @MaxLength(256)
  token!: string;

  @IsString()
  @MaxLength(128)
  publicKey!: string;

  @IsArray()
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  lanCidrs!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentVersion?: string;
}
