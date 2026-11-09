import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ConfirmActionButton, Dialog } from "./primitives";
import { toast, ToastViewport } from "../toast";

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


  it("skips focusable descendants of an ancestor hidden dynamically with display:none", () => {
    function HiddenWrapper() {
      const [open, setOpen] = useState(false);
      const [show, setShow] = useState(true);
      return <>
        <button onClick={() => setOpen(true)}>Open modal</button>
        <Dialog title="Hidden controls" open={open} onClose={() => setOpen(false)}
          actions={<>
            <button onClick={() => setShow(false)}>Hide last control</button>
            <div style={{ display: show ? "block" : "none" }}>
              <button>Invisible last control</button>
            </div>
          </>} />
      </>;
    }
    render(<HiddenWrapper />);
    const trigger = screen.getByRole("button", { name: "Open modal" });
    trigger.focus();
    fireEvent.click(trigger);
    const hide = screen.getByRole("button", { name: "Hide last control" });
    const first = screen.getByRole("button", { name: "Close dialog" });
    fireEvent.click(hide);
    hide.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(hide);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });

  it("restores original page opener when outer and inner dialogs unmount together", () => {
    const pageTrigger = <button type="button">Open shared dialogs</button>;
    function Both({ open }: { open: boolean }) {
      return <>
        {pageTrigger}
        {open && <>
          <Dialog title="Outer batch" open onClose={() => undefined}
            actions={<button>Outer action</button>}/>
          <Dialog title="Inner batch" open onClose={() => undefined}
            actions={<button>Inner action</button>}/>
        </>}
      </>;
    }
    const { rerender, container } = render(<Both open={false}/>);
    const trigger = screen.getByRole("button", { name: "Open shared dialogs" });
    trigger.focus();
    rerender(<Both open={true}/>);
    expect(container.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close dialog" }));
    rerender(<Both open={false}/>);
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("announces an API failure inside the active modal while the page is inert (#406)", () => {
    function ModalError() {
      const [open, setOpen] = useState(false);
      return <>
        <ToastViewport />
        <button onClick={() => setOpen(true)}>Create Network</button>
        <Dialog title="Create Network" open={open} onClose={() => setOpen(false)}
          actions={<button onClick={() => toast.errorFrom(new Error("Network could not be created."))}>Save Network</button>} />
      </>;
    }
    const { container } = render(<ModalError />);
    const trigger = screen.getByRole("button", { name: "Create Network" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Create Network" });
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(container.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save Network" }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Network could not be created.");
    expect(dialog.contains(alert)).toBe(true);
    expect(alert.closest("[inert], [aria-hidden='true']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("alert").textContent).toContain("Network could not be created.");
  });

  it("moves the active notification region with the highest nested dialog (#406)", () => {
    function Layered() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      return <>
        <ToastViewport />
        <button onClick={() => setOuterOpen(true)}>Open outer</button>
        <Dialog title="Outer layer" open={outerOpen} onClose={() => setOuterOpen(false)}
          actions={<button onClick={() => setInnerOpen(true)}>Open inner</button>}/>
        <Dialog title="Inner layer" open={innerOpen} onClose={() => setInnerOpen(false)}
          actions={<button onClick={() => toast.error("Inner save denied")}>Save inner</button>}/>
      </>;
    }
    render(<Layered />);
    fireEvent.click(screen.getByRole("button", { name: "Open outer" }));
    const outer = screen.getByRole("dialog", { name: "Outer layer" });
    fireEvent.click(screen.getByRole("button", { name: "Open inner" }));
    const inner = screen.getByRole("dialog", { name: "Inner layer" });
    fireEvent.click(screen.getByRole("button", { name: "Save inner" }));
    const alert = screen.getByRole("alert");
    expect(inner.contains(alert)).toBe(true);
    expect(outer.contains(alert)).toBe(false);
    expect(alert.closest("[inert], [aria-hidden='true']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog", { name: "Inner layer" })).toBeNull();
    expect(outer.contains(screen.getByRole("alert"))).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Inner save denied");
  });

});
