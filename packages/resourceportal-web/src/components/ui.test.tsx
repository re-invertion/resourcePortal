import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Callout, MetricCard, PageHeader, SectionNav, StatusBadge } from "./ui";

describe("shared console UI", () => {
  it("maps lifecycle text to a semantic status tone without relying on color alone", () => {
    render(<><StatusBadge>Running</StatusBadge><StatusBadge>Failed</StatusBadge><StatusBadge>Pending</StatusBadge></>);
    expect(screen.getByText("Running").getAttribute("data-tone")).toBe("positive");
    expect(screen.getByText("Failed").getAttribute("data-tone")).toBe("negative");
    expect(screen.getByText("Pending").getAttribute("data-tone")).toBe("warning");
  });

  it("renders actionable alerts and section navigation accessibly", () => {
    render(<><Callout tone="danger" title="Balance empty" action={<a href="/billing">Add credits</a>}>Workloads are paused.</Callout><SectionNav label="Workspace sections" items={[{ label: "Overview", href: "#overview" }, { label: "Apps", href: "#apps" }]} /></>);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Balance empty")).toBeTruthy();
    expect(within(alert).getByRole("link", { name: "Add credits" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Workspace sections" })).getByRole("link", { name: "Apps" }).getAttribute("href")).toBe("#apps");
  });

  it("provides reusable page and metric hierarchy", () => {
    render(<><PageHeader eyebrow="Tenant" title="Demo" description="Control center" actions={<button>New app</button>} /><MetricCard label="Balance" value="100 credits" detail="1 PLN" testId="balance-card" /></>);
    expect(screen.getByRole("heading", { name: "Demo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New app" })).toBeTruthy();
    expect(screen.getByTestId("balance-card").textContent).toContain("100 credits");
  });
});
