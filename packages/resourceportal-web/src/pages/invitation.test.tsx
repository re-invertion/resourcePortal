import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvitationPage } from "./invitation";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const preview = {
  tenant: { id: "22222222-2222-4222-8222-222222222222", name: "acme", displayName: "Acme Corp" },
  roles: [{ id: "tenant-admin", name: "Tenant admin" }],
  expiresAt: "2026-09-22T12:00:00.000Z",
  status: "Pending",
};

describe("InvitationPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds login and registration links that return to the invitation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(preview)));
    render(<InvitationPage token="opaque-token" user={null} />);

    expect(await screen.findByRole("heading", { name: "Join Acme Corp" })).toBeTruthy();
    const signIn = screen.getByRole("link", { name: "Sign in to accept" });
    const signUp = screen.getByRole("link", { name: "Create account" });
    expect(signIn.getAttribute("href")).toContain("/login?");
    expect(signIn.getAttribute("href")).toContain("tenantId=22222222-2222-4222-8222-222222222222");
    expect(signIn.getAttribute("href")).toContain("returnTo=%2Finvitations%2Fopaque-token");
    expect(signUp.getAttribute("href")).toContain("/register?");
  });

  it("accepts the invitation as the signed-in user and navigates to the tenant", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/invitations/opaque-token")) return json(preview);
      if (url.endsWith("/api/invitations/accept") && init?.method === "POST") {
        return json({ tenantId: preview.tenant.id, id: "membership-id" });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    render(<InvitationPage token="opaque-token" user={{ id: "user-id", email: "alice@example.com" }} navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/tenants/22222222-2222-4222-8222-222222222222/overview"));
    const acceptCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/invitations/accept"));
    expect(acceptCall?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(acceptCall?.[1]?.body))).toEqual({ token: "opaque-token" });
  });

  it("does not offer acceptance for an expired invitation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...preview, status: "Expired" })));
    render(<InvitationPage token="expired-token" user={{ id: "user-id", email: "alice@example.com" }} />);
    expect(await screen.findByText("This invitation has expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });
});
