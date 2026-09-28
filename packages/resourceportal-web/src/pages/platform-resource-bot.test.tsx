import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformResourceBotPage } from "./platform-resource-bot";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("masks the stored OpenAI key without sending the mask or rotating an untouched key", async () => {
  const state = {
    provider: "OpenAI",
    enabled: true,
    configured: true,
    available: true,
    apiKeyConfigured: true,
    generationModel: "gpt-5.6-luna",
    embeddingModel: "text-embedding-3-small",
    lastValidatedAt: "2026-09-28T12:00:00.000Z",
    lastError: null,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/platform/resource-bot" && method === "GET") return json(state);
    if (url === "/api/platform/resource-bot" && method === "PATCH") return json(state);
    return json({ error: { message: "Unexpected " + method + " " + url } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PlatformResourceBotPage />);

  const key = (await screen.findByLabelText("OpenAI API key")) as HTMLInputElement;
  expect(key.value).toBe("");
  expect(key.placeholder).toBe("");
  expect(screen.getByText("••••••••••••")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/platform/resource-bot" && init?.method === "PATCH",
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.apiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("••••");
  });
});
