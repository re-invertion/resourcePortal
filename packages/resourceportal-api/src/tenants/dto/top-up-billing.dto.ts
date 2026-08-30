import { Transform } from "class-transformer";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class TopUpBillingDto {
  @Transform(({ value }) => String(value))
  @Matches(/^(?=.*[1-9])\d+(?:\.\d{1,8})?$/)
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}
