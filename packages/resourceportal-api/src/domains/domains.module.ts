import { Module } from "@nestjs/common";
import { OperationsModule } from "../operations/operations.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PlatformDnsModule } from "../platform-dns/platform-dns.module";
import { DomainsController } from "./domains.controller";
import { DomainsService } from "./domains.service";
import { Stage16DomainsService } from "./stage16-domains.service";

@Module({
  imports: [OperationsModule, PrismaModule, PlatformDnsModule],
  controllers: [DomainsController],
  providers: [
    {
      provide: DomainsService,
      useClass: Stage16DomainsService,
    },
  ],
  exports: [DomainsService],
})
export class DomainsModule {}
