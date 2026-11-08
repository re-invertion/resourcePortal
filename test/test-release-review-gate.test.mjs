import test from "node:test";
import assert from "node:assert/strict";
import { assessReview, getReviewPrNumber } from "../scripts/release-review-gate.mjs";

const sha = "c".repeat(40);
const approvedBot = {
  author: { login: "chatgpt-codex-connector[bot]" },
  body: '<!-- codex-review-state:v1 ' + JSON.stringify({
    code_review: { commit_sha: sha, status: "completed", has_unresolved_findings: false },
  }) + ' -->',
};
function pr(overrides = {}) {
  return {
    state: "OPEN", isDraft: false, headRefOid: sha,
    reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } },
    comments: { nodes: [approvedBot], pageInfo: { hasPreviousPage: false } },
    ...overrides,
  };
}
test("PR Ready with exact-head Codex completion and no unresolved threads passes", () => {
  assert.equal(assessReview(pr(), sha, sha).state, "ready");
});
test("Draft PR is always physically blocked before review status", () => {
  assert.equal(assessReview(pr({ isDraft: true }), sha, sha).state, "blocked");
});
test("Unresolved review comments block Merge Queue even with green CI / Codex summary", () => {
  assert.match(assessReview(pr({
    reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } },
  }), sha).reason, /Unresolved/);
});
test("Incomplete paginated review thread results fail closed", () => {
  assert.equal(assessReview(pr({
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } },
  }), sha).state, "blocked");
});
test("Pending or stale Codex reviews do not certify the current head", () => {
  assert.equal(assessReview(pr({
    comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
  }), sha).state, "pending");
  const stale = {
    author: approvedBot.author,
    body: approvedBot.body.replace(sha, "a".repeat(40)),
  };
  assert.equal(assessReview(pr({
    comments: { nodes: [stale], pageInfo: { hasPreviousPage: false } },
  }), sha).state, "pending");
});
test("Codex receipt with unresolved P1 or running status blocks/pends", () => {
  const unresolved = {
    author: approvedBot.author,
    body: approvedBot.body.replace('"has_unresolved_findings":false', '"has_unresolved_findings":true'),
  };
  assert.equal(assessReview(pr({
    comments: { nodes: [unresolved] },
  }), sha).state, "blocked");
  const running = {
    author: approvedBot.author,
    body: approvedBot.body.replace('"status":"completed"', '"status":"running"'),
  };
  assert.equal(assessReview(pr({ comments: { nodes: [running] } }), sha).state, "pending");
});
test("Unauthorized user cannot spoof a Codex review receipt", () => {
  assert.equal(assessReview(pr({
    comments: { nodes: [{ ...approvedBot, author: { login: "other-user" } }] },
  }), sha).state, "pending");
});
test("Stale pull request events and moved PR heads are blocked", () => {
  assert.equal(assessReview(pr(), sha, "d".repeat(40)).state, "blocked");
  assert.equal(assessReview(pr(), "e".repeat(40)).state, "blocked");
});
test("Merge Queue resolves the exact PR number from GitHub-generated head_ref", () => {
  assert.equal(getReviewPrNumber("merge_group", {
    merge_group: { head_ref: "refs/heads/gh-readonly-queue/main/pr-407-9a930b31" },
  }), 407);
  assert.equal(getReviewPrNumber("pull_request", { number: 407 }), 407);
  assert.throws(() => getReviewPrNumber("merge_group", {
    merge_group: { head_ref: "refs/heads/main" },
  }), /Cannot establish/);
  assert.throws(() => getReviewPrNumber("push", {}), /only accepts/);
});
