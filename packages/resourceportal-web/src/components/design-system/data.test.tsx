import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./data";

describe("DataTable row links", () => {
  it("keeps the primary row link inside its cell instead of stretching an absolute overlay across the page", () => {
    render(
      <DataTable
        columns={[
          { key: "name", label: "Name" },
          { key: "state", label: "State" },
        ]}
        rows={[
          {
            key: "row-1",
            href: "/items/row-1",
            cells: { name: "Row one", state: "Ready" },
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "Row one" });
    expect(link.className).not.toContain("after:absolute");
    expect(link.className).not.toContain("after:inset-0");
  });
});
