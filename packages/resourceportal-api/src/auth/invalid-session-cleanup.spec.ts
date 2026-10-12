import { describe, expect, it, vi } from "vitest";
import { AuthSessionService } from "./auth-session.service";

describe("invalid session cookie cleanup", () => {
  it("always clears browser session and CSRF cookies, even if database revocation fails", async () => {
    const service = Object.create(AuthSessionService.prototype) as AuthSessionService;
    vi.spyOn(service, "getSessionIdFromRequest").mockReturnValue("invalid-session");
    const revoke = vi.spyOn(service, "revokeSession").mockRejectedValue(new Error("audit database unavailable"));
    const clear = vi.spyOn(service, "clearSessionCookies").mockImplementation(() => undefined);
    const request = {} as Parameters<AuthSessionService["invalidateRequestSession"]>[0];
    const reply = {} as Parameters<AuthSessionService["invalidateRequestSession"]>[1];

    await expect(service.invalidateRequestSession(request, reply)).rejects.toThrow("audit database unavailable");
    expect(revoke).toHaveBeenCalledWith("invalid-session");
    expect(clear).toHaveBeenCalledWith(reply);
  });
});
