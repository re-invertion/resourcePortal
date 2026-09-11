import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReadableDataView } from "./resource";

describe("zero raw data UI contract", () => {
  it("renders structured API objects as readable fields without a technical JSON disclosure", () => {
    render(<ReadableDataView value={{ health: "Healthy", capacity: { totalBytes: "1000" } }} />);

    expect(screen.getByText("Health")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Capacity")).toBeTruthy();
    expect(screen.getByText("Total bytes")).toBeTruthy();
    expect(screen.queryByText("Technical JSON")).toBeNull();
  });

  it("does not implement user-facing data rendering with JSON serialization", () => {
    const resourceSource = readFileSync(new URL("./resource.tsx", import.meta.url), "utf8");
    const createSource = readFileSync(new URL("./create-resource.tsx", import.meta.url), "utf8");

    expect(resourceSource).not.toContain("Technical JSON");
    expect(resourceSource).not.toMatch(/<pre>\{JSON\.stringify/);
    expect(createSource).not.toMatch(/JSON\.stringify\(value/);
  });
});
