import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppGroupIcon, ApplicationIcon } from "./application-icon";

describe("ApplicationIcon", () => {
  it("tries selfh.st/icons first and falls back to the Web UI favicon", () => {
    const { container } = render(
      <ApplicationIcon
        app={{
          name: "Plex",
          image: "ghcr.io/linuxserver/plex:latest",
          webUiUrl: "https://plex.example.test/dashboard",
        }}
      />,
    );

    const first = container.querySelector("img");
    expect(first?.getAttribute("src")).toBe(
      "https://cdn.jsdelivr.net/gh/selfhst/icons/png/plex.png",
    );

    fireEvent.error(first!);
    const favicon = container.querySelector("img");
    expect(favicon?.getAttribute("src")).toBe(
      "https://plex.example.test/favicon.ico",
    );

    fireEvent.error(favicon!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("uses the application name when the image name is unavailable", () => {
    const { container } = render(<ApplicationIcon app={{ name: "Home Assistant" }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.jsdelivr.net/gh/selfhst/icons/png/home-assistant.png",
    );
  });
});

describe("AppGroupIcon", () => {
  it("renders at most four unique application icons", () => {
    const apps = [
      { name: "Plex", image: "plex:latest" },
      { name: "Plex duplicate", image: "plex:stable" },
      { name: "Home Assistant", image: "home-assistant:latest" },
      { name: "Immich", image: "immich:latest" },
      { name: "Grafana", image: "grafana:latest" },
      { name: "Prometheus", image: "prometheus:latest" },
    ];

    const { container } = render(<AppGroupIcon apps={apps} />);
    const icons = container.querySelectorAll("[data-icon-key]");
    expect(icons).toHaveLength(4);
    expect(Array.from(icons).map((icon) => icon.getAttribute("data-icon-key"))).toEqual([
      "plex",
      "home-assistant",
      "immich",
      "grafana",
    ]);
  });
});
