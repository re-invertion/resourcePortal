import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ConfirmActionButton, Dialog } from "./primitives";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ConfirmActionButton", () => {
  it("uses the in-app dialog and runs the action only after explicit confirmation", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ConfirmActionButton
        ariaLabel="Discard pending changes"
        confirmTitle="Discard pending changes?"
        confirmDescription="This removes all undeployed draft changes."
        confirmLabel="Discard changes"
        onConfirm={onConfirm}
      >
        Discard pending changes
      </ConfirmActionButton>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard pending changes" }));
    expect(screen.getByRole("dialog", { name: "Discard pending changes?" })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(nativeConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Discard pending changes?" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard pending changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Discard pending changes?" })).toBeNull();
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
  it("keeps keyboard focus inside the dialog and restores the trigger on close", () => {
    render(
      <div>
        <button type="button">Background action</button>
        <ConfirmActionButton confirmTitle="Confirm changes?" onConfirm={vi.fn()}>
          Open confirmation
        </ConfirmActionButton>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    const background = screen.getByRole("button", { name: "Background action" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Confirm changes?" });
    const close = screen.getByRole("button", { name: "Close dialog" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(document.activeElement).toBe(close);

    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    expect(background.closest("[inert]")).toBeTruthy();
    expect(background.closest('[aria-hidden="true"]')).toBeTruthy();
    background.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(cancel);
    expect(document.activeElement).toBe(trigger);
    expect(background.closest("[inert]")).toBeNull();
    expect(background.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("only the topmost nested modal handles Escape, and restores outer focus", () => {
    function NestedDialog() {
      const [outer, setOuter] = useState(false);
      const [inner, setInner] = useState(false);
      return <>
        <button onClick={() => setOuter(true)}>Open outer</button>
        <Dialog open={outer} title="Outer" onClose={() => setOuter(false)}
          actions={<button onClick={() => setOuter(false)}>Finish outer</button>}>
          <button onClick={() => setInner(true)}>Open inner</button>
        </Dialog>
        <Dialog open={inner} title="Inner" onClose={() => setInner(false)}
          actions={<button onClick={() => setInner(false)}>Finish inner</button>}>
          <input aria-label="Inner input" />
        </Dialog>
      </>;
    }
    const { container } = render(<NestedDialog />);
    const root = container;
    const trigger = screen.getByRole("button", { name: "Open outer" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(root.hasAttribute("inert")).toBe(true);
    const openInner = screen.getByRole("button", { name: "Open inner" });
    fireEvent.click(openInner);
    const inner = screen.getByRole("dialog", { name: "Inner" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Inner input" }));
    // The background AND the first dialog are inert to keyboard/screen readers.
    expect(root.hasAttribute("inert")).toBe(true);
    const outer = screen.getByRole("dialog", { name: "Outer", hidden: true });
    expect(outer.closest("[inert]")).toBeTruthy();
    openInner.focus();
    expect(inner.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(root.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(openInner);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull();
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("skips dynamically disabled buttons and preserves preexisting background accessibility state", () => {
    function WithDynamicButtons() {
      const [open, setOpen] = useState(false);
      const [disabled, setDisabled] = useState(false);
      return <div>
        <button onClick={() => setOpen(true)}>Launch dialog</button>
        <Dialog title="Dynamic" open={open} onClose={() => setOpen(false)}
          actions={<>
            <button onClick={() => setDisabled(true)}>Disable next</button>
            <button disabled={disabled}>Next control</button>
          </>} />
      </div>;
    }
    const originalBackground = document.createElement("div");
    originalBackground.setAttribute("aria-hidden", "false");
    originalBackground.setAttribute("inert", "");
    document.body.appendChild(originalBackground);
    try {
      const { container } = render(<WithDynamicButtons />);
      const trigger = screen.getByRole("button", { name: "Launch dialog" });
      trigger.focus();
      fireEvent.click(trigger);
      expect(container.hasAttribute("inert")).toBe(true);
      const disable = screen.getByRole("button", { name: "Disable next" });
      fireEvent.click(disable);
      disable.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.activeElement).toBe(trigger);
      expect(originalBackground.getAttribute("aria-hidden")).toBe("false");
      expect(originalBackground.hasAttribute("inert")).toBe(true);
      expect(container.hasAttribute("inert")).toBe(false);
    } finally {
      originalBackground.remove();
    }
  });
});
