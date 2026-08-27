import { describe, expect, it } from "vitest";
import { getDockerImageHost } from "./docker-image";

describe("getDockerImageHost", () => {
  it("uses docker.io for Docker Hub shorthand images", () => {
    expect(getDockerImageHost("nginx:latest")).toBe("docker.io");
    expect(getDockerImageHost("library/postgres:16")).toBe("docker.io");
  });

  it("returns explicit registry hosts lowercased", () => {
    expect(getDockerImageHost("GHCR.IO/org/app:1.0.0")).toBe("ghcr.io");
    expect(getDockerImageHost("localhost:5000/app:latest")).toBe(
      "localhost:5000",
    );
  });
});
