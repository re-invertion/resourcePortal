import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import {
  RESOURCE_BOT_MAX_HISTORY_TURNS,
  RESOURCE_BOT_MAX_QUESTION_LENGTH,
} from "../resource-bot.constants";

export class ResourceBotHistoryTurnDto {
  @IsIn(["user", "assistant"])
  role!: "user" | "assistant";

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  content!: string;
}

export class ResourceBotMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(RESOURCE_BOT_MAX_QUESTION_LENGTH)
  question!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RESOURCE_BOT_MAX_HISTORY_TURNS)
  @ValidateNested({ each: true })
  @Type(() => ResourceBotHistoryTurnDto)
  history?: ResourceBotHistoryTurnDto[];

  @IsOptional()
  @IsUUID()
  requestId?: string;
}
