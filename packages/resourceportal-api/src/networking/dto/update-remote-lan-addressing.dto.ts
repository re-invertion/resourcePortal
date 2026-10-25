import {IsIn, IsOptional, IsString, Matches} from "class-validator";
export class UpdateRemoteLanAddressingDto {
  @IsIn(["DHCP","Static"])
  addressMode!: "DHCP" | "Static";
  @IsOptional() @IsString()
  @Matches(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/)
  staticAddress?: string;
  @IsOptional() @IsString()
  @Matches(/^(?:\d{1,3}\.){3}\d{1,3}$/)
  staticGateway?: string;
}
