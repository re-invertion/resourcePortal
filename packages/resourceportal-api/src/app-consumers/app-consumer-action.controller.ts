import { Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { Public } from "../auth/public.decorator";
import { AppConsumerActionService } from "./app-consumer-action.service";

type RawActionRequest = FastifyRequest & { rawBody?: Buffer };

/** Signed ZITADEL Actions V2 webhook; not an admin or tenant HTTP API. */
@Controller("app-consumer-actions")
export class AppConsumerActionController {
  constructor(private readonly authorization: AppConsumerActionService) {}

  @Public()
  @Post("preaccesstoken")
  @HttpCode(200)
  preaccesstoken(
    @Req() request: RawActionRequest,
    @Headers("zitadel-signature") signature?: string,
    @Headers("x-zitadel-signature") legacySignature?: string,
  ) {
    return this.authorization.authorize(request.rawBody, signature ?? legacySignature);
  }
}
