import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class UpdatePlatformEmailDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsIn(["STARTTLS", "TLS", "PLAIN"])
  mode?: "STARTTLS" | "TLS" | "PLAIN";

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  password?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  fromEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  fromName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  replyTo?: string | null;
}
