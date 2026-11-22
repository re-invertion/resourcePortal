import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedFormGuard } from "./use-unsaved-form-guard";

function Editor() {
  const { dirty, markDirty, clearDirty } = useUnsavedFormGuard();
  return <main>
    <label htmlFor="draft-name">Application name</label>
    <input id="draft-name" onChange={markDirty} />
    <span>{dirty ? "Unsaved edits" : "All changes saved"}</span>
    <button onClick={clearDirty}>Save draft</button>
    <a href="/tenants/t1/applications">Leave editor</a>
  </main>;
}
afterEach(() => vi.unstubAllGlobals());

it("does not block clean navigation and blocks tab/sidebar navigation after editing", () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const { container } = render(<Editor />);
  const link = screen.getByRole("link", { name: "Leave editor" });
  expect(fireEvent.click(link)).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Application name" }), { target: { value: "changed" } });
  expect(screen.getByText("Unsaved edits")).toBeTruthy();
  expect(fireEvent.click(link)).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(container.querySelector("main")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(screen.getByText("All changes saved")).toBeTruthy();
  expect(fireEvent.click(link)).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("sets a beforeunload cancellation only while the editor has unsaved edits", () => {
  render(<Editor />);
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  fireEvent.change(screen.getByRole("textbox", { name: "Application name" }), { target: { value: "changed" } });
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const saved = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(saved);
  expect(saved.defaultPrevented).toBe(false);
});

it("does not show a duplicate native unload confirmation after the user accepts discard", () => {
  const confirm = vi.fn(() => true);
  vi.stubGlobal("confirm", confirm);
  render(<Editor />);
  fireEvent.change(screen.getByRole("textbox", { name: "Application name" }), { target: { value: "new" } });
  expect(fireEvent.click(screen.getByRole("link", { name: "Leave editor" }))).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
  const approved = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(approved);
  expect(approved.defaultPrevented).toBe(false);
  const second = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(second);
  expect(second.defaultPrevented).toBe(true);
});
