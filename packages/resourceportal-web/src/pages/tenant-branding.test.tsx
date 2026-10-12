import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TenantSettingsPage } from "./tenant-settings";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "content-type": "application/json" },
});

afterEach(() => vi.unstubAllGlobals());

it("confirms tenant branding changes before PATCH and retains the internal tenant identifier", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let displayName = "Old tenant name";
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.endsWith("/branding") && init?.method === "PATCH") {
      const payload = JSON.parse(String(init.body)) as { displayName: string };
      displayName = payload.displayName;
      return json({ id: "tenant-1", name: "internal-slug", displayName, logoDataUrl: null });
    }
    if (path.endsWith("/tenants/tenant-1")) {
      return json({ id: "tenant-1", name: "internal-slug", displayName, logoDataUrl: null });
    }
    if (path.endsWith("/mcp-settings")) return json({ enabled: false, accessMode: "SelectedMembers", allowedMembershipIds: [] });
    if (path.endsWith("/resource-bot/settings")) return json({ enabled: true });
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<TenantSettingsPage tenantId="tenant-1" section="branding" />);
  const input = await screen.findByRole("textbox", { name: "Visible tenant name" });
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("Old tenant name"));
  fireEvent.change(input, { target: { value: "New tenant name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save tenant branding" }));
  expect(screen.getByText("Confirm tenant branding changes")).toBeTruthy();
  expect(calls.filter(c => c.path.endsWith("/branding"))).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Apply tenant branding" }));
  await waitFor(() => expect(calls.filter(c => c.path.endsWith("/branding"))).toHaveLength(1));
  const call = calls.find(c => c.path.endsWith("/branding"));
  expect(call?.init?.method).toBe("PATCH");
  expect(JSON.parse(String(call?.init?.body))).toEqual({ displayName: "New tenant name", logoDataUrl: null });
});
