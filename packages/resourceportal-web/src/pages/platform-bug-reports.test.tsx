import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformBugReportsPage } from "./platform-bug-reports";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseReport = {
  id: "22222222-2222-4222-8222-222222222222",
  description: "Application deploy button fails.",
  priority: "P2",
  resolved: false,
  resolvedAt: null as string | null,
  resolutionNote: null as string | null,
  url: "https://resource-portal.test/tenants/t1/applications",
  reporter: { id: "u1", email: "user@example.test", displayName: "User" },
  hasImage: true,
  imageUrl:
    "/api/platform/bug-reports/22222222-2222-4222-8222-222222222222/image",
  imageFileName: "shot.png",
  createdAt: "2026-09-28T12:00:00.000Z",
  updatedAt: "2026-09-28T12:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("PlatformBugReportsPage", () => {
  it("lists submitted reports and lets a Platform Admin change priority", async () => {
    let current = { ...baseReport };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url === "/api/platform/bug-reports" &&
          (!init?.method || init.method === "GET")
        ) {
          return json([current]);
        }
        if (url.endsWith("/priority") && init?.method === "PATCH") {
          current = { ...current, priority: "P0" };
          return json(current);
        }
        return json({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformBugReportsPage />);

    expect(
      await screen.findByText("Application deploy button fails."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open image/ }).getAttribute("href"),
    ).toContain("/image");

    const allFilter = screen.getByRole("button", {
      name: /All reports.*1.*Open reports/i,
    });
    const p2Filter = screen.getByRole("button", {
      name: /P2.*1.*Normal/i,
    });
    expect(allFilter.getAttribute("aria-pressed")).toBe("true");
    expect(p2Filter.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(p2Filter);
    expect(p2Filter.getAttribute("aria-pressed")).toBe("true");
    expect(allFilter.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "Clear priority filter" }),
    );
    expect(allFilter.getAttribute("aria-pressed")).toBe("true");

    const select = screen.getByRole("combobox", {
      name: /Priority for bug report/,
    });
    fireEvent.change(select, { target: { value: "P0" } });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/priority") && init?.method === "PATCH",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("P0"));
  });

  it("shows Unassigned reports as a first-class triage state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json([{ ...baseReport, priority: "Unassigned" }])),
    );

    render(<PlatformBugReportsPage />);

    expect(await screen.findByText("Unassigned · Unassigned")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Unassigned.*1.*Unassigned/i }),
    ).toBeTruthy();
    expect(
      (screen.getByRole("combobox", { name: /Priority for bug report/ }) as HTMLSelectElement)
        .value,
    ).toBe("Unassigned");
  });

  it("marks a report as resolved, filters by resolution status and can reopen it", async () => {
    let current = { ...baseReport };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          url === "/api/platform/bug-reports" &&
          (!init?.method || init.method === "GET")
        ) {
          return json([current]);
        }
        if (url.endsWith("/resolution") && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { resolved: boolean; resolutionNote?: string };
          current = {
            ...current,
            resolved: body.resolved,
            resolvedAt: body.resolved ? "2026-09-28T19:30:00.000Z" : null,
            resolutionNote: body.resolved ? body.resolutionNote ?? null : null,
          };
          return json(current);
        }
        return json({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<PlatformBugReportsPage />);

    expect(await screen.findByText("Open")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Open · 1/i })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Mark as resolved" }));
    const resolveDialog = screen.getByRole("dialog", { name: "Resolve bug report" });
    const resolution = within(resolveDialog).getByLabelText("Resolution description");
    fireEvent.change(resolution, { target: { value: "Moved endpoint management to Single App networking." } });
    fireEvent.click(within(resolveDialog).getByRole("button", { name: "Mark as resolved" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/resolution") &&
            init?.method === "PATCH" &&
            String(init.body).includes('"resolved":true') &&
            String(init.body).includes("Moved endpoint management"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("No bug reports")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open · 0/i }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Resolved · 1/i }));
    expect((await screen.findAllByText("Resolved")).length).toBeGreaterThan(0);
    expect(screen.getByText("Moved endpoint management to Single App networking.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open reported URL" }).getAttribute("href")).toBe("https://resource-portal.test/tenants/t1/applications");
    expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy();

    expect(
      await screen.findByText("Application deploy button fails."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/resolution") &&
            init?.method === "PATCH" &&
            String(init.body).includes('"resolved":false'),
        ),
      ).toBe(true),
    );
  });
});