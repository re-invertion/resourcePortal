import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

export class CreateDeviceVpnDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  networkIds!: string[];
}
