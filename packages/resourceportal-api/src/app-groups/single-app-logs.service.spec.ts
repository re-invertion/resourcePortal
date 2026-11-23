import { describe, expect, it, vi, afterEach } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { SingleAppLogsService } from "./single-app-logs.service";

afterEach(() => vi.unstubAllGlobals());
function fixture(name: string | null = "my-app", token = "worker-secret") {
  const findFirst = vi.fn().mockResolvedValue(name ? { name } : null);
  const get = vi.fn((key: string) => key === "INTERNAL_WORKER_TOKEN" ? token : undefined);
  const service = new SingleAppLogsService({ singleApp: { findFirst } } as never, { get } as never);
  return { findFirst, get, service };
}

describe("SingleAppLogsService", () => {
  it("checks tenant ownership and forwards only the derived Docker service name", async () => {
    const { service, findFirst } = fixture();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve ({ lines: ["2026-10-10 started"] }) });
    vi.stubGlobal("fetch", fetchMock);
    const logs = await service.list("tenant", "aabbccdd-0000-0000-0000-000000000000", "app");
    expect(findFirst).toHaveBeenCalledWith({ where: {
      id: "app", appGroupId: "aabbccdd-0000-0000-0000-000000000000", appGroup: { tenantId: "tenant" },
    }, select: { name: true } });
    const call = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(call[0]).toBe("http://127.0.0.1:3101/internal/single-app-logs");
    expect(call[1].headers["x-internal-token"]).toBe("worker-secret");
    expect(JSON.parse(call[1].body) as unknown).toEqual({ service: "rp_aabbccdd_0000_0000_0000_000000000000_my_app" });
    expect(logs.lines).toEqual(["2026-10-10 started"]);
  });

  it("rejects foreign tenant before any worker request", async () => {
    const { service } = fixture(null);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(service.list("foreign", "group", "app")).rejects.toBeInstanceOf(NotFoundException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps worker failure to sanitized 503 without exposing details", async () => {
    const { service } = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(service.list("tenant", "group", "app")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("rejects malformed worker payload", async () => {
    const { service } = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve ({ lines: [42] }) }));
    await expect(service.list("tenant", "group", "app")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("redacts OAuth callback codes, state, authorization headers and cookies before exposing logs", async () => {
    const { service } = fixture();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ lines: [
      "2026-11-20 GET /oauth2/callback?code=SECRET_CODE&state=SECRET_STATE status=500",
      "GET /api/auth/callback?code=OTHER_CODE&state=OTHER_STATE 302",
      "GET /oauth/v2/authorize?state=THIRD_STATE&nonce=NONCE&code_challenge=CHALLENGE",
      "GET /path?client_id=public-client&access_token=SECRET_ACCESS status=401",
      "Authorization: Bearer SECRET_BEARER",
      "Cookie: rp_session=SECRET_COOKIE",
      "GET /oauth2/callback?code=ESC_CODE\\u0026state=ESC_STATE status=401",
      "GET /path?refresh_token=ESC_REFRESH&amp;client_id=public-client status=403",
      "normal healthz status=200",
    ] }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service.list("tenant", "group", "app");
    const output = result.lines.join("\n");
    for (const secret of ["SECRET_CODE", "SECRET_STATE", "OTHER_CODE", "OTHER_STATE",
      "THIRD_STATE", "NONCE", "CHALLENGE", "SECRET_ACCESS", "SECRET_BEARER", "SECRET_COOKIE", "ESC_CODE", "ESC_STATE", "ESC_REFRESH"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("/oauth2/callback?[REDACTED]");
    expect(output).toContain("client_id=public-client&access_token=[REDACTED]");
    expect(output).toContain("normal healthz status=200");
    expect(output).toContain("status=500");
  });

  it("caps the response to 64KiB", async () => {
    const { service } = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve ({ lines: ["x".repeat(100000)] }) }));
    const result = await service.list("tenant", "group", "app");
    expect(result.lines.join("\n").length).toBeLessThanOrEqual(65536);
  });
});
