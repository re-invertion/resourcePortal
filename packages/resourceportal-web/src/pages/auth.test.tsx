import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthPage, PublicHealthPage } from "./auth";

function json(value: unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}})}

it("uses the ResourcePortal brand instead of a text placeholder logo", async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(json([])));
  render(<AuthPage mode="login"/>);
  expect(await screen.findAllByLabelText("ResourcePortal")).not.toHaveLength(0);
  expect(screen.queryByText("R")).toBeNull();
  expect(screen.getByRole("heading",{name:"Sign in to ResourcePortal"})).toBeTruthy();
});

it("uses the shared full-screen auth workspace layout and copy", async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(json([])));
  render(<AuthPage mode="login"/>);
  await screen.findByRole("heading",{name:"Stay in control of your infrastructure."});
  const brandPanel = screen.getByTestId("auth-workspace-aside");
  const mainPanel = screen.getByTestId("auth-workspace-main");
  expect(brandPanel.className).toContain("bg-[#122033]");
  expect(brandPanel.parentElement?.className).toContain("xl:grid-cols-[552px_minmax(0,1fr)]");
  expect(mainPanel.className).toContain("min-h-dvh");
  expect(mainPanel.className).toContain("overflow-x-hidden");
  expect(within(brandPanel).getByLabelText("ResourcePortal").className).toContain("text-white");
  expect(screen.getByText("ResourcePortal uses organization-managed SSO.")).toBeTruthy();
  expect(screen.getByRole("button",{name:/continue with (sso|platform login)/i}).className).toContain("h-12");
});

it("renders public health as a service status view instead of raw object cards", async()=>{
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/health") return json({ status: "ok", service: "resource-portal-api", dependencies: { postgres: "ok" } });
    if (url === "/api/health/live") return json({ status: "ok", service: "resource-portal-api" });
    if (url === "/api/health/ready") return json({ status: "ok", service: "resource-portal-api", dependencies: { postgres: "ok" } });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<PublicHealthPage/>);

  expect(await screen.findByRole("heading", { name: "All systems operational" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Health" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Liveness" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Readiness" })).toBeTruthy();
  expect(screen.getByText("PostgreSQL")).toBeTruthy();
  expect(screen.getAllByText("Operational").length).toBeGreaterThanOrEqual(4);
  expect(screen.queryByText("DETAILS")).toBeNull();
});
