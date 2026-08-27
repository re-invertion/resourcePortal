import { PartialType } from "@nestjs/mapped-types";
import { CreateHttpEndpointDto } from "./create-http-endpoint.dto";

export class UpdateHttpEndpointDto extends PartialType(
  CreateHttpEndpointDto,
) {}
