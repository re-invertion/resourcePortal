import { ArrayMaxSize, IsArray, IsInt, Min } from "class-validator";

export class UpdateGateDiscoveryDto {
  @IsArray()
  @ArrayMaxSize(128)
  rules!: unknown[];

  @IsInt()
  @Min(1)
  expectedRevision!: number;
}
