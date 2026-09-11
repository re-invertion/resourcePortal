import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

function read(relativePath) {
  return readFileSync(path.join(packageRoot, relativePath), "utf8");
}

describe("production Web Console styling", () => {
  it("compiles the existing preview design into the production client bundle", () => {
    const packageJson = JSON.parse(read("package.json"));
    const viteConfig = read("vite.config.ts");
    const entryClient = read("src/entry-client.tsx");
    const indexHtml = read("index.html");
    const stylesPath = path.join(packageRoot, "src/styles.css");

    expect(packageJson.devDependencies).toHaveProperty("tailwindcss");
    expect(packageJson.devDependencies).toHaveProperty("@tailwindcss/vite");
    expect(viteConfig).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(viteConfig).toContain("plugins: [tailwindcss()]");
    expect(entryClient).toContain('import "./styles.css"');
    expect(entryClient).not.toContain("@tailwindcss/browser@4");
    expect(indexHtml).not.toContain('type="text/tailwindcss"');
    expect(existsSync(stylesPath)).toBe(true);
  });

  it("preserves the usability-pass design tokens in the compiled stylesheet source", () => {
    const styles = read("src/styles.css");

    expect(styles).toContain('@import "tailwindcss"');
    expect(styles).toContain("bg-slate-50");
    expect(styles).toContain("rounded-lg border border-slate-200 bg-white p-4 shadow-sm");
    expect(styles).toContain("rp-status-pill");
    expect(styles).toContain("rp-confirm-dialog");
  });

  it("styles the resource creation wizard inside the production Tailwind stylesheet", () => {
    const styles = read("src/styles.css");
    const entryClient = read("src/entry-client.tsx");

    expect(entryClient).toContain('import "./styles.css"');
    expect(entryClient).not.toContain("create-resource.css");
    expect(styles).toContain(".rp-create-workspace");
    expect(styles).toContain(".rp-create-resource-icon");
    expect(styles).toContain(".rp-create-steps");
    expect(styles).toContain(".rp-create-review");
    expect(styles).toContain("@apply");
  });
});
