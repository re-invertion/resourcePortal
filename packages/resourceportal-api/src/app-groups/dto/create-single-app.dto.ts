import { RuntimeState } from "@prisma/client";
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateSingleAppDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  image!: string;

  @IsOptional()
  @IsUUID()
  registryId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  desiredReplicas?: number;

  @IsOptional()
  @IsEnum(RuntimeState)
  runtimeState?: RuntimeState;

  @IsNumber()
  @Min(0)
  @Max(128)
  cpu!: number;

  @IsInt()
  @Min(134217728)
  memoryBytes!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(0, { message: "GpuNotAvailable" })
  gpu?: number;

  @IsOptional()
  @IsObject()
  environment?: Record<string, string>;

  @IsOptional()
  @IsObject()
  healthCheck?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  entrypoint?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  command?: string[];

  @IsOptional()
  @IsString()
  workingDir?: string;

  @IsOptional()
  @IsString()
  user?: string;

  @IsOptional()
  @IsBoolean()
  readOnlyRootFilesystem?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  stopGracePeriodSeconds?: number;

  @IsOptional()
  @IsObject()
  restartPolicy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  updatePolicy?: Record<string, unknown>;
}
