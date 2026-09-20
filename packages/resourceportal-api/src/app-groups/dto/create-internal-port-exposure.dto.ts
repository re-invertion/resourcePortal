import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export const INTERNAL_PORT_PROTOCOLS = ["tcp", "udp"] as const;
export type InternalPortProtocol = (typeof INTERNAL_PORT_PROTOCOLS)[number];

export class CreateInternalPortExposureDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  containerPort!: number;

  @IsInt()
  @Min(1)
  @Max(65535)
  publishedPort!: number;

  @IsOptional()
  @IsIn(INTERNAL_PORT_PROTOCOLS)
  protocol?: InternalPortProtocol;
}
