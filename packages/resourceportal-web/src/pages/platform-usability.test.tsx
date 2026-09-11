import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformPage } from "./platform";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("platform action feedback", () => {
  it("reports reconcile completion without dumping the mutation response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/swarm-cluster" && (init?.method ?? "GET") === "GET") return json({ status: "Ready" });
      if (url === "/api/platform/swarm-cluster/reconcile") return json({ reconciled: true, nodeCount: 3 });
      if (url === "/api/platform/remote-locations") return json([]);
      if (url === "/api/platform/storage-backends") return json([]);
      return json({ error: { message: `Unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="infrastructure" />);
    await screen.findByText("Ready");
    fireEvent.click(screen.getByRole("button", { name: "Reconcile Swarm cluster" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Reconcile Swarm cluster completed"));
    expect(screen.queryByText("Reconciled")).toBeNull();
    expect(screen.queryByText("Node count")).toBeNull();
  });

  it("reports settings saves without rendering a second copy of the response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/maintenance" && (init?.method ?? "GET") === "GET") return json({ enabled: false, reason: "" });
      if (url === "/api/platform/maintenance" && init?.method === "PATCH") return json({ enabled: true, reason: "planned" });
      return json({ error: { message: `Unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformPage section="maintenance" />);
    await screen.findByText("Maintenance state");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Maintenance state saved"));
  });
});
