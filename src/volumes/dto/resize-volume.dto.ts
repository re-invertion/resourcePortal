import { IsInt, Min } from "class-validator";

export class ResizeVolumeDto {
  @IsInt()
  @Min(1048576)
  sizeBytes!: number;
}
