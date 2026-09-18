import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthPage } from "./auth";

function json(value: unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}})}

it("uses the ResourcePortal brand instead of a text placeholder logo", async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(json([])));
  render(<AuthPage mode="login"/>);
  expect(await screen.findAllByLabelText("ResourcePortal")).not.toHaveLength(0);
  expect(screen.queryByText("R")).toBeNull();
  expect(screen.getByRole("heading",{name:"Sign in to ResourcePortal"})).toBeTruthy();
});

it("matches the Penpot Login SSO split layout and copy", async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(json([])));
  render(<AuthPage mode="login"/>);
  const hero = await screen.findByRole("heading",{name:"Stay in control of your infrastructure."});
  const brandPanel = hero.closest("section");
  expect(brandPanel?.className).toContain("bg-[#122033]");
  expect(brandPanel?.className).toContain("lg:w-[552px]");
  expect(within(brandPanel as HTMLElement).getByLabelText("ResourcePortal").className).toContain("text-white");
  expect(screen.getByText("ResourcePortal uses organization-managed SSO.")).toBeTruthy();
  expect(screen.getByRole("button",{name:/continue with (sso|platform login)/i}).className).toContain("h-12");
});