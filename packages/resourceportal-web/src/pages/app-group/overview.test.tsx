import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AppGroupOverview } from "./overview";

it("keeps advanced settings reachable outside the six primary App Group tabs", () => {
  render(<AppGroupOverview tenantId="t1" group={{ id: "ag1", name: "commerce", runtimeState: "Running", effectiveRuntimeState: "Running", health: "Healthy", driftStatus: "InSync", hasPendingChanges: false, singleApps: [] }} />);
  const link = screen.getByRole("link", { name: /advanced & technical details/i });
  expect(link.getAttribute("href")).toBe("/tenants/t1/app-groups/ag1/advanced");
  expect(screen.getByText(/stack preview, raw detail and draft controls/i)).toBeTruthy();
  expect(screen.getByText("Effective state")).toBeTruthy();
  expect(screen.getByText(/0 applications in this App Group/i)).toBeTruthy();
});
