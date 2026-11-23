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
  fireEvent.change(screen.getByRole("textbox", { name: "Search applications" }), { target: { value: "not-existing" } });
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

it("renders technical runtime and health enums as readable labels without showing raw API tokens", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([
    { id: "app-technical", name: "scheduled-service", image: "nginx:alpine",
      runtimeState: "PENDING_DEPLOYMENT", effectiveRuntimeState: "PENDING_DEPLOYMENT",
      health: "STARTING_UP" },
  ])));
  render(<AppGroupApps tenantId="t1" appGroupId="ag1" />);
  expect(await screen.findByText("scheduled-service")).toBeTruthy();
  expect(screen.getByText("Pending deployment")).toBeTruthy();
  expect(screen.getByText("Starting up")).toBeTruthy();
  expect(screen.queryByText("PENDING_DEPLOYMENT")).toBeNull();
  expect(screen.queryByText("STARTING_UP")).toBeNull();
});
