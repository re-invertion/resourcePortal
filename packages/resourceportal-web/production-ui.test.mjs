import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
    const shell = read("src/components/shell.tsx");

    expect(entryClient).toContain('import "./styles.css"');
    expect(entryClient).not.toContain("create-resource.css");
    expect(createResource).toContain("rounded-2xl border border-slate-200 bg-white");
    expect(createResource).toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
    expect(createResource).toContain("bg-blue-600");
    expect(createResource).toContain("bg-blue-50 text-blue-700");
    expect(resourcePanel).toContain("bg-blue-600");
    expect(app).toContain("bg-[#F4F7FB]");
    expect(shell).toContain("rp-final-ui");
    expect(shell).toContain("bg-[#1769E0]");
  });
});


describe("Web console anti-clickjacking response headers", () => {
  it("sets framing and MIME-sniffing protection before HTML and static handlers", () => {
    const server = read("server.mjs");
    const proxyBoundary = server.indexOf("if (isApiProxyPath(url.pathname))");
    const framingHeader = server.indexOf('response.setHeader("content-security-policy", "frame-ancestors \'none\'")');
    const legacyHeader = server.indexOf('response.setHeader("x-frame-options", "DENY")');
    const nosniffHeader = server.indexOf('response.setHeader("x-content-type-options", "nosniff")');
    const staticHandler = server.indexOf("if (production) {", proxyBoundary);
    expect(proxyBoundary).toBeGreaterThan(-1);
    expect(framingHeader).toBeGreaterThan(proxyBoundary);
    expect(legacyHeader).toBeGreaterThan(framingHeader);
    expect(nosniffHeader).toBeGreaterThan(legacyHeader);
    expect(staticHandler).toBeGreaterThan(nosniffHeader);
  });
});

describe("live Web response headers", () => {
  it("serves anti-clickjacking headers over actual HTTP for document and static responses", async () => {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: packageRoot,
      env: { ...process.env, NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(port) },
      stdio: "ignore",
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error("Web server exited before accepting HTTP requests");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
          if (response.status < 500) { ready = true; break; }
        } catch { /* Vite is still starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      for (const pathname of ["/", "/index.html", "/src/entry-client.tsx", "/does-not-exist"]) {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(5000) });
        expect(response.headers.get("content-security-policy"), pathname).toBe("frame-ancestors 'none'");
        expect(response.headers.get("x-frame-options"), pathname).toBe("DENY");
        expect(response.headers.get("x-content-type-options"), pathname).toBe("nosniff");
      }
    } finally {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 25000);
});
