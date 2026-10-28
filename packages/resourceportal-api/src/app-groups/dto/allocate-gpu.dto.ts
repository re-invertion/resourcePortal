import { IsString, Matches } from "class-validator";
export class AllocateGpuDto {
  @IsString()
  @Matches(/^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)
  gpuUuid!: string;
}
