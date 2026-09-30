import {
  IsIn,
  IsInt,
  IsIP,
  IsOptional,
  Max,
  Min,
} from "class-validator";

export type GateRouteAdvertisementMode = "Manual" | "BGP";

export class UpdateGateRoutingDto {
  @IsIn(["Manual", "BGP"])
  mode!: GateRouteAdvertisementMode;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4_294_967_295)
  localAsn?: number;

  @IsOptional()
  @IsIP(4)
  routerAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4_294_967_295)
  routerAsn?: number;

  @IsOptional()
  @IsIP(4)
  sourceAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(9)
  @Max(65_535)
  holdTimeSeconds?: number;
}
