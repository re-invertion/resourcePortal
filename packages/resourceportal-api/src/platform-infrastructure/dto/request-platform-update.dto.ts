import { IsString, Matches } from "class-validator";

export class RequestPlatformUpdateDto {
  @IsString()
  @Matches(/^\d+\.\d+\.\d+$/)
  targetVersion!: string;

  @IsString()
  @Matches(/^AKTUALIZUJ$/)
  confirmation!: string;
}
