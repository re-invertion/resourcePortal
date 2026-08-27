import { PartialType } from "@nestjs/mapped-types";
import { CreateSingleAppDto } from "./create-single-app.dto";

export class UpdateSingleAppDto extends PartialType(CreateSingleAppDto) {}
