#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export function releaseMode(version, existingTags, milestones = [], publishedSourceTag = undefined) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid semver: ${version}`);
  const target = match.slice(1).map(Number);
  const targetText = `v${target.join(".")}`;
  const previous = existingTags
    .map((tag) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag))
    .filter(Boolean)
    .map((parts) => parts.slice(1).map(Number))
    .filter((parts) =>
      parts[0] < target[0] ||
      (parts[0] === target[0] && parts[1] < target[1]) ||
      (parts[0] === target[0] && parts[1] === target[1] && parts[2] < target[2]),
    )
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
  if (!previous) throw new Error("Missing previous release tag; cannot safely classify");
  let previousTag = `v${previous.join(".")}`;
  let source = previous;
  if (publishedSourceTag !== undefined) {
    const published = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(publishedSourceTag);
    if (!published) throw new Error("Invalid published source release tag");
    const normalized = `v${published.slice(1).join(".")}`;
    if (!existingTags.some((tag) => tag === normalized || tag === normalized.slice(1))) {
      throw new Error("Published source tag missing from checkout");
    }
    const parts = published.slice(1).map(Number);
    if (parts[0] > previous[0] ||
        (parts[0] === previous[0] && parts[1] > previous[1]) ||
        (parts[0] === previous[0] && parts[1] === previous[1] && parts[2] > previous[2])) {
      throw new Error("Published source must precede target release");
    }
    previousTag = normalized;
    source = parts;
  }
  const isMilestone = milestones.includes(targetText) ||
    milestones.includes(targetText.slice(1)) ||
    source[0] !== target[0] ||
    source[1] !== target[1];
  return { version: targetText, previousTag, mode: isMilestone ? "milestone" : "fastfix" };
}

if (process.argv[1]?.endsWith("release-validation-mode.mjs")) {
  const args = process.argv;
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const version = get("--version");
  if (!version) throw new Error("--version is required");
  const tags = execFileSync("git", ["tag", "--list", "v*"], {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const settings = JSON.parse(readFileSync("config/release-milestones.json", "utf8"));
  const result = releaseMode(version, tags, settings.milestones || [], get("--previous-published-tag"));
  console.log(JSON.stringify(result));
  const output = get("--github-output");
  if (output) {
    appendFileSync(output, `mode=${result.mode}\nprevious_tag=${result.previousTag}\n`);
  }
  if (get("--require") && get("--require") !== result.mode) {
    throw new Error(`Requested fastfix workflow for a ${result.mode} release`);
  }
}
