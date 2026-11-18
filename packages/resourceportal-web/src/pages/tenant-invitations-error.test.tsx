import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAdministrationPage } from "./tenant-access-pages";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

function setup(mode: "http-500" | "empty" | "pending") {
  let invitationAttempts = 0;
  let releasePending: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { releasePending = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/invitations")) {
      invitationAttempts++;
      if (mode === "pending" && invitationAttempts === 1) await pending;
      if (mode === "http-500" && invitationAttempts === 1) return json({ message: "Server unavailable" }, 500);
      return json([]);
    }
    return json([]);
  }));
  render(<TenantAdministrationPage tenantId="t1" section="administration" />);
  return { attempts: () => invitationAttempts, resolve: () => releasePending?.() };
}

describe("#417 invitation API empty, loading and failed states", () => {
  it("does not claim there are no invitations on HTTP 500 and allows retry", async () => {
    const api = setup("http-500");
    expect(await screen.findByText("Access data could not be loaded")).toBeTruthy();
    expect(screen.queryByText("No pending invitations")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No pending invitations")).toBeTruthy();
    expect(api.attempts()).toBe(2);
  });
  it("does not show empty state while invitations are still loading", async () => {
    const api = setup("pending");
    await waitFor(() => expect(api.attempts()).toBe(1));
    expect(screen.queryByText("No pending invitations")).toBeNull();
    api.resolve();
    expect(await screen.findByText("No pending invitations")).toBeTruthy();
  });
  it("shows empty state after a successful empty 200 response", async () => {
    setup("empty");
    expect(await screen.findByText("No pending invitations")).toBeTruthy();
    expect(screen.queryByText("Access data could not be loaded")).toBeNull();
  });
});
