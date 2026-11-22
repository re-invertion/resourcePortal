import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppGroupApps } from "./apps";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

it("distinguishes a filtered list from an empty App Group and lets the user clear search", async () => {
  const fetchMock = vi.fn(async () => json([
    { id: "app-1", name: "checkout", image: "nginx:alpine", runtimeState: "Running" },
    { id: "app-2", name: "billing", image: "nginx:alpine", runtimeState: "Stopped" },
  ]));
  vi.stubGlobal("fetch", fetchMock);
  render(<AppGroupApps tenantId="t1" appGroupId="ag1" />);
  expect(await screen.findByText("checkout")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "not-existing" } });
  expect(screen.getByText("No matching applications")).toBeTruthy();
  expect(screen.getByText("No applications match your search.")).toBeTruthy();
  expect(screen.queryByText("Create the first application in this App Group.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByText("checkout")).toBeTruthy();
  expect(screen.getByText("billing")).toBeTruthy();
});

it("distinguishes a failed application-list API from an empty list and retries", async () => {
  let attempts = 0;
  const fetchMock = vi.fn(async () => ++attempts === 1
    ? json({ message: "The upstream API is unavailable" }, 503)
    : json([{ id: "app-1", name: "checkout", image: "nginx:alpine", runtimeState: "Running" }]));
  vi.stubGlobal("fetch", fetchMock);
  render(<AppGroupApps tenantId="t1" appGroupId="ag1" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Applications could not be loaded."));
  expect(screen.queryByText("No applications")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry applications" }));
  expect(await screen.findByText("checkout")).toBeTruthy();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});
