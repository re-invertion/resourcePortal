import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBugReportsPage } from "./platform-bug-reports";

describe("PlatformBugReportsPage", () => {
  it("lists submitted reports and lets a Global Admin change priority", async () => {
    const report = {
      id: "22222222-2222-4222-8222-222222222222",
      description: "Application deploy button fails.",
      priority: "P2",
      reporter: { id: "u1", email: "user@example.test", displayName: "User" },
      hasImage: true,
      imageUrl: "/api/platform/bug-reports/22222222-2222-4222-8222-222222222222/image",
      imageFileName: "shot.png",
      createdAt: "2026-09-28T12:00:00.000Z",
      updatedAt: "2026-09-28T12:00:00.000Z",
    };
    let current = report;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/platform/bug-reports" && (!init?.method || init.method === "GET")) return new Response(JSON.stringify([current]), { status: 200, headers: { "content-type": "application/json" } });
      if (String(input).endsWith("/priority") && init?.method === "PATCH") {
        current = { ...current, priority: "P0" };
        return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PlatformBugReportsPage />);
    expect(await screen.findByText("Application deploy button fails.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open image/ }).getAttribute("href")).toContain("/image");

    const allFilter = screen.getByRole("button", { name: /All reports.*1.*Total submitted/i });
    const p2Filter = screen.getByRole("button", { name: /P2.*1.*Normal/i });
    expect(allFilter.getAttribute("aria-pressed")).toBe("true");
    expect(p2Filter.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(p2Filter);
    expect(p2Filter.getAttribute("aria-pressed")).toBe("true");
    expect(allFilter.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(allFilter.getAttribute("aria-pressed")).toBe("true");

    const select = screen.getByRole("combobox", { name: /Priority for bug report/ });
    fireEvent.change(select, { target: { value: "P0" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/priority") && init?.method === "PATCH")).toBe(true));
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("P0"));
  });
});
