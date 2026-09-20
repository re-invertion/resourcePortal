import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformDnsPage } from "./platform-dns";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("keeps the Cloudflare token write-only while allowing Platform Admin to enable managed domains", async () => {
  const initial = {
    provider: "Cloudflare",
    enabled: false,
    available: false,
    configured: true,
    tokenConfigured: true,
    zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    zoneName: "resource-portal.pl",
    baseDomain: "resource-portal.pl",
    targetHostname: "portal.resource-portal.pl",
    lastValidatedAt: "2026-09-20T12:00:00.000Z",
    lastError: null,
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/platform/dns" && (init?.method ?? "GET") === "PATCH") {
      return Promise.resolve(json({ ...initial, enabled: true, available: true }));
    }
    if (url === "/api/platform/dns") return Promise.resolve(json(initial));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformDnsPage />);

  expect(await screen.findByText("Cloudflare managed DNS")).toBeTruthy();
  await waitFor(() =>
    expect((screen.getByLabelText(/Cloudflare Zone ID/i) as HTMLInputElement).value).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ),
  );
  const token = screen.getByLabelText(/Cloudflare API token/i) as HTMLInputElement;
  expect(token.type).toBe("password");
  expect(token.value).toBe("");
  expect(token.placeholder).toMatch(/configured/i);

  fireEvent.click(screen.getByLabelText("Enable managed ResourcePortal domains"));
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

  await waitFor(() => {
    const patch = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/platform/dns" && init?.method === "PATCH",
    );
    expect(patch).toBeTruthy();
    const body = JSON.parse(String(patch?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      zoneId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(body).not.toHaveProperty("apiToken");
  });
});

it("shows an actionable Cloudflare DNS conflict instead of Internal Server Error", async () => {
  const initial = {
    provider: "Cloudflare",
    enabled: false,
    available: false,
    configured: false,
    tokenConfigured: false,
    zoneId: null,
    zoneName: null,
    baseDomain: "portal.resource-portal.pl",
    targetHostname: "portal.resource-portal.pl",
    lastValidatedAt: null,
    lastError: null,
  };
  const message =
    "Cloudflare already has an unmanaged DNS record for design.portal.resource-portal.pl. Remove or rename the existing record in Cloudflare, then retry enabling Managed ResourcePortal domains.";
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/platform/dns" && (init?.method ?? "GET") === "PATCH") {
      return Promise.resolve(
        json(
          {
            code: "CloudflareDnsRecordConflict",
            message,
            details: {
              hostname: "design.portal.resource-portal.pl",
              existingRecords: [{ type: "A", content: "109.206.199.72" }],
            },
          },
          409,
        ),
      );
    }
    if (url === "/api/platform/dns") return Promise.resolve(json(initial));
    return Promise.resolve(json({}));
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformDnsPage />);
  await screen.findByText("Cloudflare managed DNS");
  fireEvent.change(screen.getByLabelText(/Cloudflare Zone ID/i), {
    target: { value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  });
  fireEvent.change(screen.getByLabelText(/Cloudflare API token/i), {
    target: { value: "cloudflare-token-that-is-long-enough" },
  });
  fireEvent.click(screen.getByLabelText("Enable managed ResourcePortal domains"));
  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByText("Internal Server Error")).toBeNull();
});
