import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SecurityModule } from "../security/security.module";
import { NetworkingService } from "./networking.service";
import { WireGuardKeyService } from "./wireguard-key.service";

@Module({
  imports: [PrismaModule, SecurityModule],
  providers: [NetworkingService, WireGuardKeyService],
  exports: [NetworkingService, WireGuardKeyService],
})
export class NetworkingModule {}
