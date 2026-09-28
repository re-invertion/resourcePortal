import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
  ZitadelEmailProviderService,
} from "./zitadel-email-provider.service";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service() {
  const config = {
    get: vi.fn((key: string) => {
      if (key === "ZITADEL_MANAGEMENT_URL") return "https://auth.example";
      if (key === "ZITADEL_MANAGEMENT_TOKEN") return "management-token";
      return undefined;
    }),
  };
  return new ZitadelEmailProviderService(config as never);
}

describe("ZitadelEmailProviderService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates and activates a fresh managed provider with the current password", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: [{
          id: "old-provider",
          description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
          state: "EMAIL_PROVIDER_ACTIVE",
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: "new-provider" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({
        config: {
          id: "new-provider",
          description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
          state: "EMAIL_PROVIDER_ACTIVE",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({}));

    const result = await service().reconcile({
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      mode: "STARTTLS",
      username: "resourceportal",
      password: "secret",
      fromEmail: "noreply@example.com",
      fromName: "ResourcePortal",
      replyTo: "support@example.com",
    });

    expect(result).toEqual({ providerId: "new-provider" });
    const addCall = fetchMock.mock.calls[1];
    expect(addCall?.[0]).toBe("https://auth.example/admin/v1/email/smtp");
    const init = addCall?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      senderAddress: "noreply@example.com",
      senderName: "ResourcePortal",
      tls: true,
      host: "smtp.example.com:587",
      user: "resourceportal",
      replyToAddress: "support@example.com",
      description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
      plain: { password: "secret" },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://auth.example/admin/v1/email/new-provider/_activate",
    );
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      "https://auth.example/admin/v1/email/old-provider",
    );
  });

  it("maps plain unauthenticated SMTP without sending a password", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: "provider-1" }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({
        config: {
          id: "provider-1",
          description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
          state: "EMAIL_PROVIDER_ACTIVE",
        },
      }));

    await service().reconcile({
      enabled: true,
      host: "smtp.internal",
      port: 25,
      mode: "PLAIN",
      username: null,
      fromEmail: "noreply@example.com",
      fromName: null,
      replyTo: null,
    });

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual(expect.objectContaining({
      tls: false,
      host: "smtp.internal:25",
      user: "",
      none: {},
    }));
    expect(init.body as string).not.toContain("password");
  });

  it("deactivates and removes ResourcePortal-managed providers when disabled", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: [{
          id: "managed-provider",
          description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
          state: "EMAIL_PROVIDER_ACTIVE",
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        config: {
          id: "managed-provider",
          description: RESOURCEPORTAL_SMTP_PROVIDER_DESCRIPTION,
          state: "EMAIL_PROVIDER_ACTIVE",
        },
      }))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({}));

    const result = await service().reconcile({
      enabled: false,
      host: null,
      port: 587,
      mode: "STARTTLS",
      username: null,
      fromEmail: null,
      fromName: null,
      replyTo: null,
    });

    expect(result).toEqual({ providerId: null });
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://auth.example/admin/v1/email/managed-provider/_deactivate",
    );
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "https://auth.example/admin/v1/email/managed-provider",
    );
  });

  it("does not delete an active provider that is not managed by ResourcePortal", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: [] }))
      .mockResolvedValueOnce(jsonResponse({
        config: {
          id: "manual-provider",
          description: "Manually configured",
          state: "EMAIL_PROVIDER_ACTIVE",
        },
      }));

    await expect(service().reconcile({
      enabled: false,
      host: null,
      port: 587,
      mode: "STARTTLS",
      username: null,
      fromEmail: null,
      fromName: null,
      replyTo: null,
    })).rejects.toThrow("an unmanaged email provider is active");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
