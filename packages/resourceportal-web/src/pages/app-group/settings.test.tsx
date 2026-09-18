import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppGroupSettings } from "./settings";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("AppGroupSettings destructive actions", () => {
  it("confirms before discarding pending draft changes", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const onReload = vi.fn().mockResolvedValue(undefined);

    render(<AppGroupSettings tenantId="t1" appGroupId="ag1" group={{ name: "Commerce", hasPendingChanges: true }} onReload={onReload} />);

    fireEvent.click(screen.getByRole("button", { name: "Discard pending changes" }));
    expect(screen.getByRole("dialog", { name: "Discard pending changes?" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/tenants/t1/app-groups/ag1/discard-changes");
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
