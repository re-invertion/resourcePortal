import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestedPrNumber, isEligibleFailedRun, shouldRerunReview, main,
} from "../scripts/release-review-recheck.mjs";

const SHA = "b".repeat(40);
const HEAD = { commit_sha: SHA, status: "completed",
  has_unresolved_findings: false, has_any_findings: false };
const RECEIPT = "<!-- codex-review-state:v1 " + JSON.stringify({
  code_review: HEAD, security_review: { commit_sha: null, status: null },
}) + " -->";

const PR = {
  state: "OPEN", isDraft: false, headRefOid: SHA,
  reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } },
  comments: { nodes: [{ author: { login: "chatgpt-codex-connector[bot]" }, body: RECEIPT }] },
};
const RUN = {
  id: 491, status: "completed", conclusion: "failure", event: "pull_request",
  name: "ResourcePortal Release Readiness", head_sha: SHA,
  path: ".github/workflows/release-readiness.yml",
  created_at: "2026-11-08T18:00:00Z",
  pull_requests: [{ number: 415 }],
};
const JOBS = [
  { name: "Build and validate release candidate", conclusion: "success" },
  { name: "Production installer gate", conclusion: "success" },
  { name: "Real Swarm gate", conclusion: "skipped" },
  { name: "Required release readiness", conclusion: "failure", steps: [
    { name: "Fail closed unless all applicable pre-merge checks succeeded", conclusion: "success" },
    { name: "Reject Draft and unresolved Codex review before Merge Queue", conclusion: "failure" },
  ] },
];
function snapshot(value) { return structuredClone(value); }

test("only trusted bot review summary comments on actual PRs trigger recheck", () => {
  const comment = { action: "edited", issue: { number: 415, pull_request: { url: "https://github" } },
    comment: { user: { login: "chatgpt-codex-connector[bot]" }, body: RECEIPT } };
  assert.equal(requestedPrNumber("issue_comment", comment), 415);
  assert.equal(requestedPrNumber("issue_comment", { ...comment, action: "created" }), 415);
  assert.equal(requestedPrNumber("issue_comment", { ...comment, action: "deleted" }), null);
  assert.equal(requestedPrNumber("issue_comment", { ...comment,
    comment: { ...comment.comment, user: { login: "untrusted-user" } } }), null);
  assert.equal(requestedPrNumber("issue_comment", { ...comment, issue: { number: 415 } }), null);
  assert.equal(requestedPrNumber("issue_comment", { ...comment,
    comment: { ...comment.comment, body: "@codex review" } }), null);
  assert.equal(requestedPrNumber("pull_request", comment), null);
});
test("only exact SHA run with successful prerequisites and FAILED review step may rerun", () => {
  assert.equal(isEligibleFailedRun(RUN, SHA, 415, JOBS), true);
  assert.equal(isEligibleFailedRun({ ...RUN, head_sha: "a".repeat(40) }, SHA, 415, JOBS), false);
  assert.equal(isEligibleFailedRun({ ...RUN, name: "ResourcePortal CI + Installer" }, SHA, 415, JOBS), false);
  assert.equal(isEligibleFailedRun({ ...RUN, event: "merge_group" }, SHA, 415, JOBS), false);
  assert.equal(isEligibleFailedRun({ ...RUN, status: "in_progress" }, SHA, 415, JOBS), false);
  assert.equal(isEligibleFailedRun({ ...RUN, conclusion: "success" }, SHA, 415, JOBS), false);
  assert.equal(isEligibleFailedRun({ ...RUN, pull_requests: [{ number: 416 }] }, SHA, 415, JOBS), false);
  const candidateFailed = snapshot(JOBS);
  candidateFailed[0].conclusion = "failure";
  assert.equal(isEligibleFailedRun(RUN, SHA, 415, candidateFailed), false);
  const originalGateFailed = snapshot(JOBS);
  originalGateFailed[3].steps[0].conclusion = "failure";
  assert.equal(isEligibleFailedRun(RUN, SHA, 415, originalGateFailed), false);
  const reviewWasSuccessful = snapshot(JOBS);
  reviewWasSuccessful[3].steps[1].conclusion = "success";
  assert.equal(isEligibleFailedRun(RUN, SHA, 415, reviewWasSuccessful), false);
});
test("Draft, unresolved thread, stale or finding reviews never request reruns", () => {
  assert.equal(shouldRerunReview(PR, SHA), true);
  assert.equal(shouldRerunReview({ ...PR, isDraft: true }, SHA), false);
  assert.equal(shouldRerunReview({ ...PR,
    reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } } }, SHA), false);
  assert.equal(shouldRerunReview(PR, "a".repeat(40)), false);
  const withFinding = JSON.parse(RECEIPT.match(/<!-- codex-review-state:v1 (.*) -->/)[1]);
  withFinding.code_review.has_any_findings = true;
  assert.equal(shouldRerunReview({ ...PR, comments: { nodes: [{
    author: { login: "chatgpt-codex-connector[bot]" },
    body: "<!-- codex-review-state:v1 " + JSON.stringify(withFinding) + " -->",
  }] } }, SHA), false);
});

test("trusted bot update retries only original failed job, without synthesizing checks", async () => {
  const event = { action: "edited", issue: { number: 415, pull_request: {} },
    comment: { user: { login: "chatgpt-codex-connector[bot]" }, body: RECEIPT } };
  const root = mkdtempSync(join(tmpdir(), "rp-review-recheck-"));
  const path = join(root, "github-event.json");
  writeFileSync(path, JSON.stringify(event));
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const uri = String(url);
    calls.push({ uri, method: options?.method ?? "GET" });
    let body;
    if (uri.endsWith("/graphql")) body = { data: { repository: { pullRequest: PR } } };
    else if (uri.includes("/actions/workflows/release-readiness.yml/runs?"))
      body = { workflow_runs: [RUN] };
    else if (uri.includes("/actions/runs/491/jobs?")) body = { jobs: JOBS };
    else if (uri.endsWith("/actions/runs/491/rerun-failed-jobs")) {
      assert.equal(options.method, "POST");
      assert.match(options.headers.Authorization, /^Bearer mock-test-token$/);
      return new Response(null, { status: 201 });
    } else throw Error("Unexpected GitHub URL " + uri);
    return new Response(JSON.stringify(body), { status: 200,
      headers: { "Content-Type": "application/json" } });
  };
  try {
    await main({ GITHUB_REPOSITORY: "re-invertion/resourcePortal",
      GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: path,
      GITHUB_TOKEN: "mock-test-token" });
    assert.equal(calls.filter(c => c.method === "POST" &&
      c.uri.endsWith("/actions/runs/491/rerun-failed-jobs")).length, 1);
    assert.equal(calls.filter(c => c.uri.endsWith("/graphql")).length, 2);
    assert.ok(calls[0].uri.endsWith("/graphql"));
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spoofed source never issues a GitHub API call", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-review-recheck-bad-"));
  const path = join(root, "github-event.json");
  writeFileSync(path, JSON.stringify({ action: "edited", issue: { number: 415, pull_request: {} },
    comment: { user: { login: "attacker" }, body: RECEIPT } }));
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Never access API from attacker event"); };
  try {
    await main({ GITHUB_REPOSITORY: "re-invertion/resourcePortal",
      GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: path,
      GITHUB_TOKEN: "mock-test-token" });
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled reconciliation handles resolved threads without a GitHub review event", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-review-recheck-cron-"));
  const path = join(root, "event.json");
  writeFileSync(path, "{}");
  const original = globalThis.fetch;
  let reruns = 0;
  globalThis.fetch = async (url, opts) => {
    const uri = String(url);
    if (uri.endsWith("/graphql"))
      return Response.json({ data: { repository: { pullRequest: PR } } });
    if (uri.includes("status=failure"))
      return Response.json({ workflow_runs: [RUN] });
    if (uri.includes("head_sha="))
      return Response.json({ workflow_runs: [RUN] });
    if (uri.includes("/jobs?"))
      return Response.json({ jobs: JOBS });
    if (uri.endsWith("/rerun-failed-jobs")) {
      assert.equal(opts.method, "POST");
      reruns++;
      return new Response(null, { status: 201 });
    }
    throw Error("Unexpected GitHub URL " + uri);
  };
  try {
    await main({ GITHUB_REPOSITORY: "re-invertion/resourcePortal",
      GITHUB_EVENT_NAME: "schedule", GITHUB_EVENT_PATH: path,
      GITHUB_TOKEN: "mock-test-token" });
    assert.equal(reruns, 1);
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});
