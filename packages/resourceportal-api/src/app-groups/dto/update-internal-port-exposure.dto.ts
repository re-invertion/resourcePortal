import { PartialType } from "@nestjs/mapped-types";
import { CreateInternalPortExposureDto } from "./create-internal-port-exposure.dto";

export class UpdateInternalPortExposureDto extends PartialType(
  CreateInternalPortExposureDto,
) {}
