import { DomainType } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

export class CreateDomainDto {
  @IsEnum(DomainType)
  type!: DomainType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  prefix?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  @Matches(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  )
  hostname?: string;

  @IsOptional()
  @IsUUID()
  customRootDomainId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  subdomain?: string;

  @IsOptional()
  @IsUUID()
  httpEndpointId?: string;

  @IsOptional()
  @IsBoolean()
  tlsEnabled?: boolean;
}
