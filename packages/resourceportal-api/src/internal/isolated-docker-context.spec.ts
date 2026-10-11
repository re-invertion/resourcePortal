import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDockerContextWithoutRegistryCredentials } from "./isolated-docker-context";

describe("isolated Docker CLI contexts do not copy shared registry tokens (#218)", () => {
  it("copies the named context but not the source config.json authentication store", async () => {
    const source = await mkdtemp(join(tmpdir(), "rp-global-docker-test-"));
    const dest = await mkdtemp(join(tmpdir(), "rp-isolated-docker-test-"));
    const oldConfig = process.env.DOCKER_CONFIG;
    try {
      await mkdir(join(source, "contexts", "meta"), { recursive: true });
      await writeFile(join(source, "config.json"), JSON.stringify({
        auths: { "registry.example.com": { auth: "tenant-A-secret" } },
      }));
      await writeFile(join(source, "contexts", "meta", "example"), "named-context");
      process.env.DOCKER_CONFIG = source;
      await copyDockerContextWithoutRegistryCredentials(dest, "some-context");
      expect(await readFile(join(dest, "contexts", "meta", "example"), "utf8"))
        .toBe("named-context");
      await expect(readFile(join(dest, "config.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (oldConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = oldConfig;
      await rm(source, { recursive: true, force: true });
      await rm(dest, { recursive: true, force: true });
    }
  });
});
