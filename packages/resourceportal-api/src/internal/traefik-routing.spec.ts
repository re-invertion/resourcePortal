import { describe, expect, it } from "vitest";
import {
  protocolModeRequiresTls,
  renderTraefikLabels,
} from "./traefik-routing";

function render(protocolMode: string, certResolver?: string) {
  return renderTraefikLabels(
    {
      name: "web",
      httpEndpoints: [
        {
          name: "public",
          containerPort: 8080,
          protocolMode,
          domains: [{ hostname: "app.example.com" }],
        },
      ],
    },
    { certResolver },
  );
}

describe("protocolModeRequiresTls", () => {
  it("requires TLS for every protocol mode except HTTP", () => {
    expect(protocolModeRequiresTls("HTTP")).toBe(false);
    expect(protocolModeRequiresTls("HTTPS")).toBe(true);
    expect(protocolModeRequiresTls("HTTP_AND_HTTPS")).toBe(true);
    expect(protocolModeRequiresTls("HTTP_REDIRECT_TO_HTTPS")).toBe(true);
  });
});

describe("renderTraefikLabels", () => {
  it("renders an HTTP-only router without TLS resolver", () => {
    expect(render("HTTP", "letsencrypt")).toMatchObject({
      "traefik.http.services.web-public.loadbalancer.server.port": "8080",
      "traefik.http.routers.web-public.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public.service": "web-public",
    });
    expect(render("HTTP", "letsencrypt")).not.toHaveProperty(
      "traefik.http.routers.web-public.tls",
    );
    expect(render("HTTP", "letsencrypt")).not.toHaveProperty(
      "traefik.http.routers.web-public.tls.certresolver",
    );
  });

  it("renders an HTTPS-only router with certificate resolver", () => {
    expect(render("HTTPS", "letsencrypt")).toMatchObject({
      "traefik.http.routers.web-public.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public.service": "web-public",
      "traefik.http.routers.web-public.tls": "true",
      "traefik.http.routers.web-public.tls.certresolver": "letsencrypt",
    });
  });

  it("renders separate HTTP and HTTPS routers with resolver only on HTTPS", () => {
    expect(render("HTTP_AND_HTTPS", "letsencrypt")).toMatchObject({
      "traefik.http.routers.web-public-http.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-http.service": "web-public",
      "traefik.http.routers.web-public-https.rule": "Host(`app.example.com`)",
      "traefik.http.routers.web-public-https.service": "web-public",
      "traefik.http.routers.web-public-https.tls": "true",
      "traefik.http.routers.web-public-https.tls.certresolver": "letsencrypt",
    });
    expect(render("HTTP_AND_HTTPS", "letsencrypt")).not.toHaveProperty(
      "traefik.http.routers.web-public-http.tls.certresolver",
    );
  });

  it("renders HTTP to HTTPS redirect and a TLS router with resolver", () => {
    expect(render("HTTP_REDIRECT_TO_HTTPS", "letsencrypt")).toMatchObject({
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
      "traefik.http.routers.web-public-https.tls.certresolver": "letsencrypt",
    });
  });

  it("does not invent a certificate resolver when none is configured", () => {
    expect(render("HTTPS")).not.toHaveProperty(
      "traefik.http.routers.web-public.tls.certresolver",
    );
  });
});
