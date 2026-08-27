import { DeploymentPhase } from "@prisma/client";
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class AdvanceDeploymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  workerId!: string;

  @IsEnum(DeploymentPhase)
  phase!: DeploymentPhase;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}
