import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BugReportDialog } from "./bug-report-dialog";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("prefills the current URL and sends it with the bug report", async () => {
  window.history.replaceState({}, "", "/tenants/t1/applications");
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ id: "r1" }));
  vi.stubGlobal("fetch", fetchMock);

  render(<BugReportDialog open onClose={vi.fn()} />);

  const url = screen.getByLabelText("Bug page URL") as HTMLInputElement;
  expect(url.value).toContain("/tenants/t1/applications");
  fireEvent.change(screen.getByLabelText("Bug description"), {
    target: { value: "Something is broken on this page." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [, init] = fetchMock.mock.calls[0];
  const body = JSON.parse(String(init?.body));
  expect(body.url).toContain("/tenants/t1/applications");
});

it("accepts an image pasted from the clipboard", async () => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ id: "r1" }));
  vi.stubGlobal("fetch", fetchMock);
  const file = new File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    "clipboard.png",
    { type: "image/png" },
  );

  render(<BugReportDialog open onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Bug description"), {
    target: { value: "Pasted screenshot demonstrates the problem." },
  });

  const form = document.getElementById("bug-report-form");
  expect(form).toBeTruthy();
  fireEvent.paste(form!, {
    clipboardData: {
      items: [
        {
          kind: "file",
          type: "image/png",
          getAsFile: () => file,
        },
      ],
    },
  });

  expect(await screen.findByAltText("Bug attachment preview")).toBeTruthy();
  expect(screen.getByText("clipboard.png")).toBeTruthy();
});