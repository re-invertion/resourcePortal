import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

export class UpdatePlatformResourceBotDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(["OpenAI"])
  provider?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9._:-]+$/)
  generationModel?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9._:-]+$/)
  embeddingModel?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  apiKey?: string;
}
