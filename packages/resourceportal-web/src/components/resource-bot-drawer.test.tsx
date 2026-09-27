import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceBotDrawer } from "./resource-bot-drawer";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResourceBotDrawer", () => {
  it("sends a bounded Help question and renders validated sources plus usage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/resource-bot/status")) {
        return json({
          available: true,
          tenantEnabled: true,
          platformAvailable: true,
          priceAvailable: true,
          billingActive: true,
          generationModel: "gpt-5.6-luna",
          reason: null,
        });
      }
      if (url.endsWith("/resource-bot/messages") && init?.method === "POST") {
        return json({
          requestId: "11111111-1111-4111-8111-111111111111",
          answer: "Create an App Group first, then add the application.",
          supportedByHelp: true,
          sources: [{
            chunkId: "chunk-1",
            sectionId: "create-application",
            title: "Create and deploy an application",
            href: "/tenants/tenant-1/help#create-application",
          }],
          usage: {
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 30,
            totalTokens: 150,
            chargedCredits: "0.0042",
          },
        });
      }
      return json({});
    }));

    render(<ResourceBotDrawer tenantId="tenant-1" />);
    const launcher = screen.getByRole("button", { name: "Open ResourceBot" });
    expect(launcher.className).toContain("lg:left-4");
    expect(launcher.className).toContain("lg:right-auto");
    expect(launcher.className).toContain("lg:z-[60]");
    fireEvent.click(launcher);

    expect(await screen.findByText("Ask about ResourcePortal")).toBeTruthy();
    const input = screen.getByLabelText("Ask ResourceBot");
    fireEvent.change(input, { target: { value: "Jak utworzyć aplikację?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask ResourceBot" }));

    expect(await screen.findByText("Create an App Group first, then add the application.")).toBeTruthy();
    const source = screen.getByRole("link", { name: "Create and deploy an application" });
    expect(source.getAttribute("href")).toBe("/tenants/tenant-1/help#create-application");
    expect(screen.getByText(/150 tokens · 0.0042 credits/)).toBeTruthy();

    await waitFor(() => {
      const request = calls.find((call) => call.url.endsWith("/resource-bot/messages"));
      expect(request).toBeTruthy();
      expect(JSON.parse(String(request?.init?.body))).toEqual({
        question: "Jak utworzyć aplikację?",
        history: [],
      });
    });
  });

  it("disables the prompt when tenant billing is suspended", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/resource-bot/status")) {
        return json({
          available: false,
          tenantEnabled: true,
          platformAvailable: true,
          priceAvailable: true,
          billingActive: false,
          reason: "ResourceBotBillingSuspended",
        });
      }
      return json({});
    }));

    render(<ResourceBotDrawer tenantId="tenant-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Open ResourceBot" }));

    expect(await screen.findByText("ResourceBot is unavailable while tenant billing is suspended.")).toBeTruthy();
    expect((screen.getByLabelText("Ask ResourceBot") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
