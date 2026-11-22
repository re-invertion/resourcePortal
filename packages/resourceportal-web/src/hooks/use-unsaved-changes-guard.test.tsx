import { fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

function Editor({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty);
  return <a href="/tenants/example/other">Change section</a>;
}

afterEach(() => vi.unstubAllGlobals());

it("permits navigation without unsaved changes", () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const { getByRole } = render(<Editor dirty={false} />);
  expect(fireEvent.click(getByRole("link"))).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
});

it("blocks section navigation when unsaved edits are discarded without approval", () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const { getByRole } = render(<Editor dirty />);
  expect(fireEvent.click(getByRole("link"))).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("allows explicit confirmation to discard edits", () => {
  vi.stubGlobal("confirm", vi.fn(() => true));
  const { getByRole } = render(<Editor dirty />);
  expect(fireEvent.click(getByRole("link"))).toBe(true);
});

it("warns on tab close when changes are unsaved", () => {
  const { rerender } = render(<Editor dirty />);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  rerender(<Editor dirty={false} />);
  const cleanEvent = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(cleanEvent);
  expect(cleanEvent.defaultPrevented).toBe(false);
});
