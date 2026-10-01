import { apiRequest } from "../api/client";

export type ProviderLogoutResponse = {
  logoutUrl?: string | null;
  providerTokenRevoked?: boolean;
};

export async function providerLogoutTarget() {
  try {
    const result = await apiRequest<ProviderLogoutResponse>("/api/auth/logout/provider", {
      method: "POST",
    });
    return result.logoutUrl || "/login";
  } catch {
    // A failed provider logout must never trap the browser in the authenticated
    // ResourcePortal shell. The local session endpoint clears on provider logout
    // attempts, and /login is the safe fallback if the provider cannot supply an
    // end-session URL.
    return "/login";
  }
}
