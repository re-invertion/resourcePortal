import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandBar } from "./command-bar";

describe("CommandBar", () => {
  it("keeps overflow actions outside the toolbar and opens them in a menu", () => {
    const restart = vi.fn();
    render(<CommandBar actions={[
      { id: "start", label: "Start", onClick: vi.fn() },
      { id: "restart", label: "Restart", onClick: restart, overflow: true },
    ]} />);

    const bar = screen.getByRole("toolbar", { name: "Resource actions" });
    expect(within(bar).getByRole("button", { name: "Start" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Restart" })).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "More actions" }));

    const menu = screen.getByRole("menu", { name: "More actions" });
    const restartItem = within(menu).getByRole("menuitem", { name: "Restart" });
    expect(restartItem).toBeTruthy();
    fireEvent.click(restartItem);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("closes the overflow menu with Escape", () => {
    render(<CommandBar actions={[
      { id: "refresh", label: "Refresh", onClick: vi.fn() },
      { id: "delete", label: "Delete", onClick: vi.fn(), overflow: true, destructive: true },
    ]} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "More actions" })).toBeNull();
  });
});
