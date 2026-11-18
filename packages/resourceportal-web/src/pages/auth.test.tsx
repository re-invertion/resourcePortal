import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthPage, PublicHealthPage, interactiveAuthUrl, probeOidcBeforeLogin } from "./auth";

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

it("preserves invitation returnTo and tenant context in interactive auth URLs",()=>{
  expect(interactiveAuthUrl(
    "login",
    "22222222-2222-4222-8222-222222222222",
    "provider-id",
    "/invitations/opaque-token",
  )).toBe(
    "/api/auth/login?tenantId=22222222-2222-4222-8222-222222222222&identityProviderId=provider-id&returnTo=%2Finvitations%2Fopaque-token",
  );
});

it("checks public issuer reachability without stale browser session cookies (#439 Codex)", async () => {
  document.cookie = "rp_session=stale-browser-session; path=/";
  const fetchMock = vi.fn().mockResolvedValue(json({ status: "ready" }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(probeOidcBeforeLogin()).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenCalledWith("/api/health/oidc", {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  // Other application requests may require cookies; only the public OIDC
  // readiness check omits them. Sign-in redirects still use browser cookies.
  document.cookie = "rp_session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

it("shows a retryable identity-provider outage instead of navigating to raw HTTP 500", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/auth/providers")) return json([]);
    if (String(input) === "/api/health/oidc") return new Response(JSON.stringify({
      code: "OIDC_PROVIDER_UNAVAILABLE",
      message: "Identity provider is temporarily unavailable",
    }), { status: 503, headers: { "content-type": "application/json" } });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthPage mode="login"/>);
  const button = await screen.findByRole("button", { name: "Continue with SSO" });
  fireEvent.click(button);
  expect(await screen.findByText(/ResourcePortal cannot connect to the sign-in provider/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/health/oidc", {
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
});

it("does not offer a misleading SSO action after providers HTTP 500 (#447)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Server error" }), {
    status: 500, headers: { "content-type": "application/json" },
  })));
  render(<AuthPage mode="login" />);
  expect(await screen.findByText("Authentication providers unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue with SSO" })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry loading sign-in options" })).toBeTruthy();
});

it("recovers from provider network error on retry without stale SSO options (#447)", async () => {
  let resolveRetry!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveRetry = resolve; });
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new Error("Network unavailable"))
    .mockImplementationOnce(() => pending);
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthPage mode="login" />);
  const retry = await screen.findByRole("button", { name: "Retry loading sign-in options" });
  fireEvent.click(retry);
  expect(screen.getByText("Loading sign-in options…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue with SSO" })).toBeNull();
  resolveRetry(json([{ id: "org-a", name: "Organization A" }, { id: "org-b", name: "Organization B" }]));
  expect(await screen.findByRole("button", { name: "Continue with Organization A" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Organization B" })).toBeTruthy();
  expect(screen.queryByText("Authentication providers unavailable")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("offers generic SSO only after successful empty provider discovery (#447)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));
  render(<AuthPage mode="login" />);
  expect(await screen.findByRole("button", { name: "Continue with SSO" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry loading sign-in options" })).toBeNull();
});

it("renders each configured provider rather than a misleading empty-list SSO (#447)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ providers: [
    { id: "provider-1", name: "Company One" },
    { id: "provider-2", name: "Company Two" },
  ] })));
  render(<AuthPage mode="login" />);
  expect(await screen.findByRole("button", { name: "Continue with Company One" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue with Company Two" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue with SSO" })).toBeNull();
});
