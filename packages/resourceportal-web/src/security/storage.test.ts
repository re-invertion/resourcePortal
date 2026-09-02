import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function productionSources(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await productionSources(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) result.push(path);
  }
  return result;
}

describe("browser storage security", () => {
  it("does not persist Resource Portal credentials or tokens", async () => {
    const files = await productionSources(join(process.cwd(), "src"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/(?:localStorage|sessionStorage)\s*\./);
      expect(source, file).not.toMatch(/authorization\s*:\s*[`'"]Bearer/i);
    }
  });
});
