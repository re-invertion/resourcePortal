import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

describe("App deep tenant routes", () => {
  it("preserves App Group application segments through the full App routing layer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return json({ id: "u1", displayName: "User", email: "u@example.test" });
      if (path === "/api/tenants") return json([{ id: "t1", name: "Tenant", status: "Active" }]);
      if (path === "/api/platform/maintenance") return json({ enabled: false });
      if (path === "/api/tenants/t1/memberships") return json([]);
      if (path === "/api/tenants/t1/app-groups/ag1") return json({ id: "ag1", name: "commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false });
      if (path === "/api/tenants/t1/app-groups/ag1/single-apps") return json([{ id: "app1", name: "checkout", image: "ghcr.io/acme/checkout:1", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", desiredReplicas: 1, cpu: 0.5, memoryBytes: 536870912 }]);
      if (path.endsWith("/runtime-config")) return json({ environment: {}, secrets: [] });
      if (path.endsWith("/http-endpoints")) return json([]);
      return json([]);
    }));

    render(<App initialPath="/tenants/t1/app-groups/ag1/apps/app1" />);
    expect(await screen.findByRole("heading", { name: "checkout" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /edit application/i })).toBeTruthy();
  });
});
