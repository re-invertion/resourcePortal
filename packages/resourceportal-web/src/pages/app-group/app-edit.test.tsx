import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationEdit } from "./app-edit";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("lists existing configuration attachments and detaches them by attachment id", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/single-apps") && method === "GET") {
      return json([{
        id: "app1",
        name: "checkout",
        image: "nginx:latest",
        runtimeState: "Running",
        effectiveRuntimeState: "Running",
        variableAttachments: [{
          id: "att-var-1",
          targetName: "DATABASE_URL",
          variable: { id: "var-1", name: "DATABASE_URL" },
        }],
        secretAttachments: [],
        configAttachments: [],
        volumeAttachments: [],
      }]);
    }
    if (url.endsWith("/runtime-config")) return json({ environment: {} });
    if (url.endsWith("/registries")) return json([]);
    if (url.endsWith("/volumes")) return json([]);
    if (url.endsWith("/variables")) return json([{ id: "var-1", name: "DATABASE_URL" }]);
    if (url.endsWith("/secrets")) return json([]);
    if (url.endsWith("/configs")) return json([]);
    if (url.endsWith("/http-endpoints")) return json([]);
    if (url.endsWith("/variable-attachments/att-var-1") && method === "DELETE") return json({ deleted: true });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<ApplicationEdit tenantId="t1" appGroupId="ag1" appId="app1" subsection="configuration" />);

  expect(await screen.findByText("Current attachments")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Detach DATABASE_URL" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Detach DATABASE_URL" }));
  fireEvent.click(await screen.findByRole("button", { name: "Detach resource" }));

  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/single-apps/app1/variable-attachments/att-var-1") &&
      init?.method === "DELETE",
    )).toBe(true),
  );
});
