import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";
import { RUNTIME_CONFIG_NAME_PATTERN } from "./update-runtime-config.dto";

export class AttachVariableDto {
  @IsString()
  @IsNotEmpty()
  variableId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(RUNTIME_CONFIG_NAME_PATTERN)
  targetName!: string;
}
