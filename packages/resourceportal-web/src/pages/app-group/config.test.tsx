import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupConfig } from "./config";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupConfig destructive actions", () => {
  it("confirms in-app before deleting a reusable variable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/variables") && (!init?.method || init.method === "GET")) return json([{ id: "var1", name: "DATABASE_URL", description: "DB" }]);
      if ((path.endsWith("/secrets") || path.endsWith("/configs")) && (!init?.method || init.method === "GET")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AppGroupConfig tenantId="t1" appGroupId="ag1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete DATABASE_URL" }));
    expect(screen.getByRole("dialog", { name: "Delete DATABASE_URL?" })).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([_, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete variable" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith("/variables/var1") && (init as RequestInit | undefined)?.method === "DELETE")).toBe(true));
  });
});

it.each([
  ["variables", "Variables"],
  ["secrets", "Secrets"],
  ["configs", "Configs"],
])("distinguishes failed %s loading from an empty list and retries", async (kind, title) => {
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith(`/${kind}`)) {
      requests++;
      return requests === 1
        ? json({ message: "service unavailable" }, 503)
        : json([]);
    }
    return json([]);
  }));
  render(<AppGroupConfig tenantId="t1" appGroupId="ag1" />);
  const errorText = `${title} could not be loaded. Existing items may still exist.`;
  expect(await screen.findByText(errorText)).toBeTruthy();
  expect(screen.queryByText(`No ${kind} yet`)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `Retry ${kind}` }));
  await waitFor(() => expect(requests).toBe(2));
  expect(await screen.findByText(`No ${kind} yet`)).toBeTruthy();
  expect(screen.queryByText(errorText)).toBeNull();
});

it("guards modified configuration edits against silent Cancel and route navigation", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([]));
  vi.stubGlobal("fetch", fetchMock);
  const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<><a href="/tenants/t1/app-groups/ag1/networking">Networking</a><AppGroupConfig tenantId="t1" appGroupId="ag1" /></>);

  fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
  fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "DATABASE_URL" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(nativeConfirm).toHaveBeenCalledWith("You have unsaved changes. Discard your edits?");
  expect(screen.getByRole("textbox", { name: /Name/ })).toHaveProperty("value", "DATABASE_URL");

  const link = screen.getByRole("link", { name: "Networking" });
  fireEvent.click(link);
  expect(nativeConfirm).toHaveBeenCalledWith("You have unsaved changes. Leave this page and discard your edits?");

  nativeConfirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox", { name: /Name/ })).toBeNull();
  expect(fetchMock.mock.calls.some(([, init]) => ["POST", "PATCH", "DELETE"].includes((init as RequestInit | undefined)?.method ?? ""))).toBe(false);
  nativeConfirm.mockRestore();
});

it.each([
  ["variables", 0],
  ["secrets", 1],
  ["configs", 2],
] as const)("validates required value for new %s before enabling Create", async (kind, index) => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json([]));
  vi.stubGlobal("fetch", fetchMock);
  render(<AppGroupConfig tenantId="t1" appGroupId="ag1" />);
  fireEvent.click(screen.getAllByRole("button", { name: "Add" })[index]);
  fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "entry" } });
  const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  const value = screen.getByRole("textbox", { name: "Value" });
  expect(value.hasAttribute("required")).toBe(true);
  expect(value.getAttribute("aria-required")).toBe("true");
  fireEvent.change(value, { target: { value: "configuration-value" } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, opts]) =>
    String(url).endsWith(`/${kind}`) && opts?.method === "POST"
  )).toBe(true));
});
