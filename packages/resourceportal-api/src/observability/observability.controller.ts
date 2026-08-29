import { Controller, Get, Header } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { ObservabilityService } from "./observability.service";

@Public()
@Controller("metrics")
export class ObservabilityController {
  constructor(private readonly observability: ObservabilityService) {}

  @Get()
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  getMetrics() {
    return this.observability.renderPrometheusMetrics();
  }
}
