import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantCredentialsPage } from "./tenant-access-pages";
function json(v: unknown) {
  return new Response(JSON.stringify(v), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe("one-time rotated credentials persistence and audit status (#261)", () => {
  for (const kind of ["service-identities"]) {
    it(`warns on partially failed ${kind} rotation while keeping secret visible`, async () => {
      const warning = "Remote secret changed; reconcile local client credential storage";
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/rotate-credentials")) {
          return Promise.resolve(json({
            clientId: "client-1", clientSecret: "one-time-secret",
            persistenceStatus: "Failed", auditStatus: "Skipped", warning,
          }));
        }
        if (url.endsWith("/roles")) return Promise.resolve(json([]));
        if (url.endsWith("/service-identities")) return Promise.resolve(json(kind==="service-identities" ? [{ id: "item1", name: "Worker" }] : []));
        if (url.endsWith("/oauth-applications")) return Promise.resolve(json(kind==="oauth-applications" ? [{ id: "item1", name: "Machine", type: "Machine" }] : []));
        return Promise.resolve(json([]));
      }));
      render(<TenantCredentialsPage tenantId="t1" />);
      const rotate = await screen.findByRole("button", { name: "Rotate credentials" });
      fireEvent.click(rotate);
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByText(warning)).toBeTruthy();
      expect(screen.getByText("one-time-secret")).toBeTruthy();
      expect(screen.getByText(/Persistence: Failed/)).toBeTruthy();
    });
  }
});

describe("machine credentials use service identities, not unsupported OAuth Machine apps", () => {
  it("keeps machine credentials in service identities without duplicating tenant OAuth client creation", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/roles")) return Promise.resolve(json([{ id: "tenant-viewer", name: "Viewer" }]));
      return Promise.resolve(json([]));
    }));
    render(<TenantCredentialsPage tenantId="t1" />);
    expect(screen.getByRole("button", { name: "Create service identity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create OAuth application" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Application SSO" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Create service identity" }));
    expect(screen.getByRole("option", { name: "Viewer" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Machine" })).toBeNull();
  });
});
