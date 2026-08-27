import { PartialType } from "@nestjs/mapped-types";
import { CreateRegistryDto } from "./create-registry.dto";

export class UpdateRegistryDto extends PartialType(CreateRegistryDto) {}
