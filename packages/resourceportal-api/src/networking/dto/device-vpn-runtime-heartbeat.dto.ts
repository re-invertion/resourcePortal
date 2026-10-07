import { Type } from "class-transformer";
import {
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

class DeviceVpnPeerHandshakeDto {
  @IsString()
  publicKey!: string;

  @IsInt()
  @Min(0)
  @Max(4102444800)
  latestHandshake!: number;
}

export class DeviceVpnRuntimeHeartbeatDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DeviceVpnPeerHandshakeDto)
  peers!: DeviceVpnPeerHandshakeDto[];
}
