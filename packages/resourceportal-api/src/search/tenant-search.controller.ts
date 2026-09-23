import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { Authenticated } from "../auth/authenticated.decorator";
import { TenantSearchService } from "./tenant-search.service";

@Controller("tenants/:tenantId/search")
export class TenantSearchController {
  constructor(private readonly searchService: TenantSearchService) {}

  @Authenticated()
  @Get()
  search(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Query("q") query: string | undefined,
    @Query("limit") limit: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    return this.searchService.search({
      tenantId,
      query,
      limit,
      permissions: request.tenantContext?.permissions ?? [],
    });
  }
}
