import { describe, expect, it, vi } from "vitest";
import { apiRequest, readCsrfToken } from "./client";

describe("browser API transport", () => {
  it("always uses same-origin credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/auth/me");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({
      credentials: "same-origin",
    }));
  });

  it("adds the double-submit CSRF token to unsafe requests", async () => {
    document.cookie = "rp_csrf=csrf-value; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/auth/logout", { method: "POST" });

    const [, options] = fetchMock.mock.calls[0];
    const headers = new Headers(options.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-value");
    expect(readCsrfToken()).toBe("csrf-value");
  });

  it("does not add CSRF to safe requests", async () => {
    document.cookie = "rp_csrf=csrf-value; Path=/";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/tenants");

    const [, options] = fetchMock.mock.calls[0];
    const headers = new Headers(options.headers);
    expect(headers.has("x-csrf-token")).toBe(false);
  });

  it("preserves structured error diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "PermissionDenied",
        message: "Denied",
        details: { permission: "app_group.read" },
      },
      requestId: "req-1",
      correlationId: "corr-1",
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));

    await expect(apiRequest("/api/tenants/t1/app-groups")).rejects.toMatchObject({
      status: 403,
      code: "PermissionDenied",
      message: "Denied",
      requestId: "req-1",
      correlationId: "corr-1",
    });
  });
});
