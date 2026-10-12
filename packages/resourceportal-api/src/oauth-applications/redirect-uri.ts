import { BadRequestException } from "@nestjs/common";
import type { OAuthApplicationType } from "./dto/create-oauth-application.dto";

/** Reject remote-code and insecure public redirect URI schemes. */
export function validateOAuthRedirectUris(
  type: OAuthApplicationType,
  redirectUris: string[],
  postLogoutRedirectUris: string[],
  isProduction: boolean,
) {
  if (type === "Machine") {
    if (redirectUris.length || postLogoutRedirectUris.length) {
      throw new BadRequestException("Machine applications do not accept redirect URIs");
    }
    return;
  }
  if (!redirectUris.length) {
    throw new BadRequestException(`${type} applications require at least one redirect URI`);
  }
  const all = [...redirectUris, ...postLogoutRedirectUris];
  if (new Set(redirectUris).size !== redirectUris.length ||
      new Set(postLogoutRedirectUris).size !== postLogoutRedirectUris.length) {
    throw new BadRequestException("Duplicate application redirect URIs are not allowed");
  }
  for (const uri of all) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new BadRequestException("Invalid application redirect URI");
    }
    if (parsed.hash || parsed.username || parsed.password) {
      throw new BadRequestException("Redirect URI fragments and embedded credentials are forbidden");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    const devHttp = parsed.protocol === "http:" && loopback &&
      (type === "Native" || !isProduction);
    const nativeCustomScheme = type === "Native" &&
      /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) &&
      !["https:", "http:", "javascript:", "data:", "file:", "ftp:"].includes(parsed.protocol);
    if (parsed.protocol !== "https:" && !devHttp && !nativeCustomScheme) {
      throw new BadRequestException("Secure HTTPS redirect URI is required");
    }
  }
}
