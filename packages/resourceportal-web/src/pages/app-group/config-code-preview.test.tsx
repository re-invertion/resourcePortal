import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ConfigCodePreview } from "./config";

it("displays JSON syntax with colored, escaped content in a readonly preview", () => {
  render(<ConfigCodePreview filename="settings.json" content='{"enabled": true, "danger": "<script>"}' />);
  expect(screen.getByText("Syntax: json")).toBeTruthy();
  const preview = screen.getByTestId("config-code-preview");
  expect(preview.textContent).toContain("<script>");
  expect(preview.querySelector("script")).toBeNull();
  expect(preview.querySelector(".text-\\[\\#85C2FF\\]")).toBeTruthy();
});
