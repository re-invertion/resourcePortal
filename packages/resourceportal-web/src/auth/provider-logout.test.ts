import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import { providerLogoutTarget } from "./provider-logout";

vi.mock("../api/client", () => ({
  apiRequest: vi.fn(),
}));

const request = vi.mocked(apiRequest);

describe("providerLogoutTarget", () => {
  beforeEach(() => {
    request.mockReset();
  });

  it("uses the provider end-session URL when ZITADEL supplies one", async () => {
    request.mockResolvedValue({
      logoutUrl: "https://auth.example/oidc/v1/end_session?id_token_hint=test",
      providerTokenRevoked: true,
    });

    await expect(providerLogoutTarget()).resolves.toBe(
      "https://auth.example/oidc/v1/end_session?id_token_hint=test",
    );
    expect(request).toHaveBeenCalledWith("/api/auth/logout/provider", {
      method: "POST",
    });
  });

  it("falls back to the local login page when provider logout is unavailable", async () => {
    request.mockResolvedValue({ logoutUrl: null, providerTokenRevoked: false });
    await expect(providerLogoutTarget()).resolves.toBe("/login");

    request.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(providerLogoutTarget()).resolves.toBe("/login");
  });
});
