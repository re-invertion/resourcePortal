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

  it("uses production Tailwind utilities for the cloud-style creation wizard", () => {
    const entryClient = read("src/entry-client.tsx");
    const createResource = read("src/components/create-resource.tsx");
    const resourcePanel = read("src/components/resource.tsx");
    const app = read("src/App.tsx");

    expect(entryClient).toContain('import "./styles.css"');
    expect(entryClient).not.toContain("create-resource.css");
    expect(createResource).toContain("rounded-2xl border border-slate-200 bg-white");
    expect(createResource).toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
    expect(createResource).toContain("bg-blue-600");
    expect(createResource).toContain("bg-blue-50 text-blue-700");
    expect(resourcePanel).toContain("bg-blue-600");
    expect(app).toContain("bg-blue-600");
  });

  it("does not expose raw API objects in normal product views", () => {
    const resourceSource = read("src/components/resource.tsx");
    const createSource = read("src/components/create-resource.tsx");

    expect(resourceSource).not.toContain("Technical JSON");
    expect(resourceSource).not.toMatch(/<pre>\{JSON\.stringify\(value, null, 2\)\}<\/pre>/);
    expect(createSource).not.toMatch(/JSON\.stringify\(entry\)/);
    expect(createSource).not.toMatch(/<code>\{JSON\.stringify\(value\)\}<\/code>/);
  });
});
