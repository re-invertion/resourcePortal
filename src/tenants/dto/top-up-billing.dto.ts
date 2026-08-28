import { IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

export class TopUpBillingDto {
  @IsNumber()
  @Min(0.0001)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}
