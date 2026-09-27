import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformSettingsPage } from "./platform-settings";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlatformSettingsPage SMTP", () => {
  it("keeps SMTP credentials write-only and supports save, connection test and test email", async () => {
    const state = {
      enabled: true,
      configured: true,
      host: "smtp.example.com",
      port: 587,
      mode: "STARTTLS",
      username: "resourceportal",
      passwordConfigured: true,
      fromEmail: "noreply@example.com",
      fromName: "ResourcePortal",
      replyTo: null,
      lastValidatedAt: "2026-09-27T16:00:00.000Z",
      lastTestSentAt: null,
      lastError: null,
    };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, init });
      if (path === "/api/platform/email" && (!init?.method || init.method === "GET")) return json(state);
      if (path === "/api/platform/email" && init?.method === "PATCH") return json(state);
      if (path === "/api/platform/email/validate" && init?.method === "POST") return json(state);
      if (path === "/api/platform/email/test" && init?.method === "POST") return json({ ...state, lastTestSentAt: "2026-09-27T16:30:00.000Z" });
      return json({}, 404);
    }));

    render(<PlatformSettingsPage />);

    expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
    const password = screen.getByLabelText("SMTP password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toContain("Configured");
    expect(screen.queryByDisplayValue(/secret|password/i)).toBeNull();
    await waitFor(() => expect((screen.getByLabelText("SMTP host") as HTMLInputElement).value).toBe("smtp.example.com"));

    fireEvent.change(screen.getByLabelText("SMTP host"), { target: { value: "smtp2.example.com" } });
    expect((screen.getByLabelText("SMTP host") as HTMLInputElement).value).toBe("smtp2.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Save SMTP settings" }));

    await waitFor(() => {
      const call = calls.find(({ path, init }) => path === "/api/platform/email" && init?.method === "PATCH");
      expect(call).toBeTruthy();
      const body = JSON.parse(String(call?.init?.body));
      expect(body.host).toBe("smtp2.example.com");
      expect(body.password).toBeUndefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(calls.some(({ path, init }) => path === "/api/platform/email/validate" && init?.method === "POST")).toBe(true));

    fireEvent.change(screen.getByLabelText("SMTP test recipient"), { target: { value: "admin@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => {
      const call = calls.find(({ path, init }) => path === "/api/platform/email/test" && init?.method === "POST");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.init?.body))).toEqual({ recipient: "admin@example.com" });
    });
  });

  it("warns when plain SMTP is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      enabled: false,
      configured: false,
      host: "",
      port: 25,
      mode: "PLAIN",
      passwordConfigured: false,
    })));

    render(<PlatformSettingsPage />);
    expect(await screen.findByText("Plain SMTP is not encrypted")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save SMTP settings" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
