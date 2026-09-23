import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TenantSearchController } from "./tenant-search.controller";
import { TenantSearchService } from "./tenant-search.service";

@Module({
  imports: [PrismaModule],
  controllers: [TenantSearchController],
  providers: [TenantSearchService],
})
export class SearchModule {}
