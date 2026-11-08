#!/usr/bin/env node
/**
 * Trusted review recheck dispatcher. issue_comment events run on main, NOT on
 * the PR SHA; therefore they can never satisfy required checks by themselves.
 * Only rerun a previously failed REQUIRED review job on the original PR SHA.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessReview, loadReviewPr } from "./release-review-gate.mjs";

export const CODEX_BOT = "chatgpt-codex-connector[bot]";
const WORKFLOW = "release-readiness.yml";
const REQUIRED = "Required release readiness";
const REVIEW_STEP = "Reject Draft and unresolved Codex review before Merge Queue";
const CHECK_STEP = "Fail closed unless all applicable pre-merge checks succeeded";

export function requestedPrNumber(eventName, event) {
  if (eventName !== "issue_comment") return null;
  if (!["created", "edited"].includes(event.action) ||
      event.comment?.user?.login !== CODEX_BOT ||
      !event.issue?.pull_request ||
      !event.comment?.body?.includes("<!-- codex-review-state:v1 ")) return null;
  const n = event.issue.number;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function isEligibleFailedRun(run, headSha, number, jobs) {
  if (run?.status !== "completed" || run.conclusion !== "failure" ||
      run.event !== "pull_request" || run.name !== "ResourcePortal Release Readiness" ||
      run.head_sha !== headSha ||
      !run.path?.includes(".github/workflows/" + WORKFLOW) ||
      !run.pull_requests?.some(pr => pr.number === number) || !Array.isArray(jobs)) return false;
  const required = jobs.find(j => j.name === REQUIRED && j.conclusion === "failure");
  const candidate = jobs.find(j => j.name === "Build and validate release candidate" && j.conclusion === "success");
  if (!required || !candidate ||
      jobs.some(j => j.name !== REQUIRED && !["success", "skipped"].includes(j.conclusion))) return false;
  const prerequisites = required.steps?.find(step => step.name === CHECK_STEP);
  const review = required.steps?.find(step => step.name === REVIEW_STEP);
  return prerequisites?.conclusion === "success" && review?.conclusion === "failure";
}

export function shouldRerunReview(pr, sha) {
  return assessReview(pr, sha).state === "ready";
}

async function githubApi(token, repo, path, options = {}) {
  const response = await fetch("https://api.github.com/repos/" + repo + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("GitHub API " + path + " HTTP " + response.status);
  // Re-run endpoint may return 201 with an empty body: no response JSON is
  // required, and a dispatched rerun is not itself a successful review gate.
  return options.method === "POST" || response.status === 204 ? null : response.json();
}

async function openPrsWithFailedReviewRuns(token, repo) {
  const found = new Set();
  // Bounded scan. Authoritative PR head and review state are rechecked below.
  for (let page = 1; page <= 3; page++) {
    const data = await githubApi(token, repo,
      "/actions/workflows/" + WORKFLOW +
      "/runs?event=pull_request&status=failure&per_page=100&page=" + page);
    const runs = data?.workflow_runs ?? [];
    for (const run of runs) {
      for (const pr of run.pull_requests ?? []) {
        if (Number.isSafeInteger(pr.number) && pr.number > 0) found.add(pr.number);
      }
    }
    if (runs.length < 100) break;
  }
  return [...found].slice(0, 100);
}

async function checkAndRerun(owner, name, token, number) {
  const repo = owner + "/" + name;
  const pr = await loadReviewPr(owner, name, number, token);
  const sha = pr?.headRefOid ?? "";
  if (!shouldRerunReview(pr, sha)) return "review-not-ready";
  const result = await githubApi(token, repo,
    "/actions/workflows/" + WORKFLOW +
    "/runs?event=pull_request&head_sha=" + encodeURIComponent(sha) +
    "&per_page=50");
  const matches = (result?.workflow_runs ?? [])
    .filter(run => run.pull_requests?.some(p => p.number === number))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const latest = matches[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "failure") {
    return "no-failed-required-run";
  }
  const jobResult = await githubApi(token, repo,
    "/actions/runs/" + latest.id + "/jobs?filter=latest&per_page=100");
  if (!isEligibleFailedRun(latest, sha, number, jobResult?.jobs)) {
    return "no-isolated-review-failure";
  }
  // Reject a concurrent code change or freshly opened thread before dispatch.
  const after = await loadReviewPr(owner, name, number, token);
  if (after?.headRefOid !== sha || !shouldRerunReview(after, sha)) {
    return "review-changed-before-rerun";
  }
  await githubApi(token, repo, "/actions/runs/" + latest.id + "/rerun-failed-jobs",
    { method: "POST" });
  console.log("Rechecking failed review on PR #" + number + " SHA " +
    sha.slice(0, 12) + " via workflow " + latest.id);
  return "rerun-dispatched";
}

export async function main(env = process.env) {
  const [owner, name] = (env.GITHUB_REPOSITORY ?? "").split("/");
  assert.match(owner ?? "", /^[a-zA-Z0-9_-]+$/);
  assert.match(name ?? "", /^[a-zA-Z0-9_.-]+$/);
  const token = env.GITHUB_TOKEN;
  assert.match(token ?? "", /\S/);
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  let numbers;
  if (env.GITHUB_EVENT_NAME === "issue_comment") {
    const number = requestedPrNumber(env.GITHUB_EVENT_NAME, event);
    numbers = number === null ? [] : [number];
  } else if (env.GITHUB_EVENT_NAME === "schedule") {
    numbers = await openPrsWithFailedReviewRuns(token, owner + "/" + name);
  } else {
    throw Error("Unsupported review recheck event");
  }
  for (const number of numbers) {
    const status = await checkAndRerun(owner, name, token, number);
    console.log("PR #" + number + ": " + status);
  }
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
