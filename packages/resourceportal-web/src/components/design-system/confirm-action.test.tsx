import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmActionButton } from "./primitives";

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
});
