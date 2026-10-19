import { describe, expect, it, vi, afterEach } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { SingleAppLogsService } from "./single-app-logs.service";

afterEach(() => vi.unstubAllGlobals());
function fixture(name: string | null = "my-app", token = "worker-secret") {
  const findFirst = vi.fn().mockResolvedValue(name ? { name } : null);
  const get = vi.fn().mockReturnValue(token);
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
    expect(call[0]).toBe("http://worker:3101/internal/single-app-logs");
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

  it("caps the response to 64KiB", async () => {
    const { service } = fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve ({ lines: ["x".repeat(100000)] }) }));
    const result = await service.list("tenant", "group", "app");
    expect(result.lines.join("\n").length).toBeLessThanOrEqual(65536);
  });
});
