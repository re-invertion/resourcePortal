import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { RUNTIME_CONFIG_NAME_PATTERN } from "./update-runtime-config.dto";

export class CreateVariableDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(RUNTIME_CONFIG_NAME_PATTERN)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @MaxLength(20000)
  value!: string;
}
