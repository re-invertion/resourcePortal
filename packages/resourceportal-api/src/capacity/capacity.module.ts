import { Module } from "@nestjs/common";
import { CapacityPreflightService } from "./capacity-preflight.service";

@Module({
  providers: [CapacityPreflightService],
  exports: [CapacityPreflightService],
})
export class CapacityModule {}
