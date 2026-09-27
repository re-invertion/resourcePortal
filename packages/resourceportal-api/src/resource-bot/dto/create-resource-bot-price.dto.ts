import {
  IsDateString,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

const DECIMAL_RATE = /^\d+(?:\.\d{1,8})?$/;

export class CreateResourceBotPriceDto {
  @IsString()
  @IsIn(["OpenAI"])
  provider!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(128)
  model!: string;

  @IsDateString()
  effectiveFrom!: string;

  @IsString()
  @Matches(DECIMAL_RATE)
  inputCreditsPer1M!: string;

  @IsString()
  @Matches(DECIMAL_RATE)
  cachedInputCreditsPer1M!: string;

  @IsString()
  @Matches(DECIMAL_RATE)
  outputCreditsPer1M!: string;

  @IsString()
  @Matches(DECIMAL_RATE)
  embeddingCreditsPer1M!: string;
}
