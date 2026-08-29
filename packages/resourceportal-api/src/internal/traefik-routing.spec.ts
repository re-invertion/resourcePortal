import { describe, expect, it } from "vitest";
import { renderTraefikLabels } from "./traefik-routing";

function render(protocolMode: string) {
  return renderTraefikLabels({
    name: "web",
    httpEndpoints: [
      {
        name: "public",
        containerPort: 8080,
        protocolMode,
        domains: [{ hostname: "app.example.com" }],
      },
    ],
  });
}

describe("renderTraefikLabels", () => {
  it("renders an HTTP-only router", () => {
    expect(render("HTTP")).toMatchObject({
      "traefik.http.services.web-public.loadbalancer.server.port": "8080",
      "traefik.http.routers.web-public.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public.service": "web-public",
    });
    expect(render("HTTP")).not.toHaveProperty(
      "traefik.http.routers.web-public.tls",
    );
  });

  it("renders an HTTPS-only router", () => {
    expect(render("HTTPS")).toMatchObject({
      "traefik.http.routers.web-public.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public.service": "web-public",
      "traefik.http.routers.web-public.tls": "true",
    });
  });

  it("renders separate HTTP and HTTPS routers", () => {
    expect(render("HTTP_AND_HTTPS")).toMatchObject({
      "traefik.http.routers.web-public-http.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-http.service": "web-public",
      "traefik.http.routers.web-public-https.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-https.service": "web-public",
      "traefik.http.routers.web-public-https.tls": "true",
    });
  });

  it("renders HTTP to HTTPS redirect and a TLS router", () => {
    expect(render("HTTP_REDIRECT_TO_HTTPS")).toMatchObject({
      "traefik.http.routers.web-public-http.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-http.service": "web-public",
      "traefik.http.routers.web-public-http.middlewares":
        "web-public-https-redirect",
      "traefik.http.middlewares.web-public-https-redirect.redirectscheme.scheme":
        "https",
      "traefik.http.middlewares.web-public-https-redirect.redirectscheme.permanent":
        "true",
      "traefik.http.routers.web-public-https.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-https.service": "web-public",
      "traefik.http.routers.web-public-https.tls": "true",
    });
  });
});
