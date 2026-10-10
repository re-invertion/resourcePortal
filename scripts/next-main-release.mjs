#!/usr/bin/env node
// Every main push gets a fresh version. Failed/orphan tags are never reused.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { releaseMode } from "./release-validation-mode.mjs";

const parse = (tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);

export function nextMainRelease(tags, publishedTag, milestones = []) {
  const published = parse(publishedTag);
  if (!published || !tags.includes(publishedTag)) {
    throw new Error("Latest published release tag must exist in this checkout");
  }
  const sorted = tags.map(parse).filter(Boolean).sort((a, b) =>
    b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  if (!sorted.length) throw new Error("No semver tags");
  const latest = sorted[0];
  if (latest[0] !== published[0] || latest[1] !== published[1]) {
    throw new Error("Unpublished milestone tag exists; reconcile before merge");
  }
  const next = `v${latest[0]}.${latest[1]}.${latest[2] + 1}`;
  const classified = releaseMode(next, [publishedTag], milestones);
  return { version: next.slice(1), previousTag: publishedTag, mode: classified.mode };
}

export function alreadyPublishedMainRelease(publishedTag, publishedCommit, target, assetNames) {
  if (publishedCommit !== target) return null;
  const version = publishedTag.slice(1);
  for (const name of [
    `resource-portal-cli-${version}.tgz`,
    "resourceportal-release-manifest.json",
    "SHA256SUMS",
  ]) {
    if (!assetNames.includes(name)) {
      throw new Error(`Published release is incomplete (${name} missing); fail closed`);
    }
  }
  return { version, previousTag: publishedTag, mode: "published" };
}

function shell(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

if (process.argv[1]?.endsWith("/next-main-release.mjs")) {
  const target = shell("git", ["rev-parse", "HEAD"]);
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== target) {
    throw new Error("Checkout must match the exact main push commit");
  }
  const publishedTag = shell("gh", [
    "api", `repos/${process.env.GITHUB_REPOSITORY}/releases/latest`,
    "--jq", ".tag_name",
  ]);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", publishedTag, "HEAD"]);
  if (ancestor.status !== 0) {
    throw new Error("Latest published tag is not an ancestor of main");
  }
  const publishedCommit = shell("git", ["rev-list", "-n", "1", publishedTag]);
  const tags = shell("git", ["tag", "--list", "v*"]).split("\n").filter(Boolean);
  const milestones = JSON.parse(readFileSync("config/release-milestones.json", "utf8")).milestones ?? [];
  // An Actions re-run of an already published SHA is a verified no-op.
  // Without this guard the allocator could create a second patch for the same merge.
  let plan;
  if (publishedCommit === target) {
    const publishedAssets = JSON.parse(shell("gh", [
      "api", `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${publishedTag}`,
      "--jq", ".assets | map(.name)",
    ]));
    plan = alreadyPublishedMainRelease(publishedTag, publishedCommit, target, publishedAssets);
  } else {
    plan = nextMainRelease(tags, publishedTag, milestones);
  }
  console.log(JSON.stringify({ ...plan, target }));
  const index = process.argv.indexOf("--github-output");
  if (index >= 0) {
    appendFileSync(process.argv[index + 1], [
      `version=${plan.version}`,
      `previous_tag=${plan.previousTag}`,
      `mode=${plan.mode}`,
      "",
    ].join("\n"));
  }
}
