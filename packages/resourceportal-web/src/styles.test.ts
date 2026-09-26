import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
}

describe("shared code block styles", () => {
  it("keeps code blocks dark while preserving readable selected text", () => {
    expect(rule("pre")).toContain("bg-slate-950");
    expect(rule("pre")).toContain("text-slate-100");

    expect(rule("pre code")).toContain("bg-transparent");
    expect(rule("pre code")).toContain("text-inherit");

    const selectionRule = styles.match(/pre::selection,\s*pre \*::selection\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(selectionRule).toContain("bg-blue-600");
    expect(selectionRule).toContain("text-white");
  });
});
