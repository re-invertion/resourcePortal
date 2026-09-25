import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import {
  GateAgentController,
  NetworkingController,
} from "./networking.controller";
import { NetworkingModule } from "./networking.module";

@Module({
  imports: [NetworkingModule, OperationsModule],
  controllers: [NetworkingController, GateAgentController],
})
export class NetworkingApiModule {}
