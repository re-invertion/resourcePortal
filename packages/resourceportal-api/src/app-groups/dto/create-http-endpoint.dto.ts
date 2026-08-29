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

export const HTTP_ENDPOINT_PROTOCOL_MODES = [
  "HTTP",
  "HTTPS",
  "HTTP_AND_HTTPS",
  "HTTP_REDIRECT_TO_HTTPS",
] as const;

export type HttpEndpointProtocolMode =
  (typeof HTTP_ENDPOINT_PROTOCOL_MODES)[number];

export class CreateHttpEndpointDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  containerPort!: number;

  @IsOptional()
  @IsIn(HTTP_ENDPOINT_PROTOCOL_MODES)
  protocolMode?: HttpEndpointProtocolMode;
}
