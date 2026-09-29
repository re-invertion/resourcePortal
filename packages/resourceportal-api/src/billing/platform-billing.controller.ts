import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { PlatformAdminGuard } from "../auth/platform-admin.guard";
import { AuthenticatedUser } from "../auth/types";
import {
  CreatePriceListDto,
  CreateVoucherDto,
  PlatformCorrectionDto,
  PlatformPaymentDto,
  PlatformRefundDto,
  PlatformUsageSeriesQueryDto,
  UsageSeriesQueryDto,
} from "./billing.dto";
import { BillingService } from "./billing.service";
import { BillingReadService } from "./billing-read.service";

@Controller("platform/billing")
@UseGuards(PlatformAdminGuard)
export class PlatformBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly billingRead: BillingReadService,
  ) {}

  @Get("usage-series")
  usageSeries(@Query() query: PlatformUsageSeriesQueryDto) {
    const { tenantId, from, to, bucket } = query;
    const usageQuery = Object.assign(new UsageSeriesQueryDto(), {
      from,
      to,
      bucket,
    });
    return this.billingRead.usageSeries(tenantId, usageQuery);
  }

  @Get("price-lists")
  listPriceLists() {
    return this.billing.listPriceLists();
  }

  @Get("price-lists/:priceListId")
  getPriceList(@Param("priceListId", ParseUUIDPipe) priceListId: string) {
    return this.billing.getPriceList(priceListId);
  }

  @Post("price-lists")
  createPriceList(
    @Body() dto: CreatePriceListDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.createPriceList(dto, actor);
  }

  @Get("vouchers")
  listVouchers() {
    return this.billing.listVouchers();
  }

  @Get("vouchers/:voucherId")
  getVoucher(@Param("voucherId", ParseUUIDPipe) voucherId: string) {
    return this.billing.getVoucher(voucherId);
  }

  @Post("vouchers")
  createVoucher(
    @Body() dto: CreateVoucherDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.createVoucher(dto, actor);
  }

  @Post("vouchers/:voucherId/disable")
  disableVoucher(
    @Param("voucherId", ParseUUIDPipe) voucherId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.disableVoucher(voucherId, actor);
  }

  @Post("payments")
  payment(
    @Body() dto: PlatformPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.payment(dto, actor);
  }

  @Post("refunds")
  refund(
    @Body() dto: PlatformRefundDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.refund(dto, actor);
  }

  @Post("corrections")
  correction(
    @Body() dto: PlatformCorrectionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.billing.correction(dto, actor);
  }
}
