import { SetMetadata } from "@nestjs/common";
import { IS_AUTHENTICATED_KEY } from "./auth.constants";

export const Authenticated = () => SetMetadata(IS_AUTHENTICATED_KEY, true);
