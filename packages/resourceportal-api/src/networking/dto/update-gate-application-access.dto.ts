import { ArrayMaxSize, IsArray, IsInt, Min } from "class-validator";

export class UpdateGateApplicationAccessDto {
  @IsArray()
  @ArrayMaxSize(256)
  rules!: unknown[];

  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
