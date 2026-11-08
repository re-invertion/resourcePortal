/**
 * Required release-readiness safeguard against asynchronous code review races.
 * A PR may not join Merge Queue merely because CI is green before Codex reviews
 * the exact head SHA. Uses GitHub-authoritative PR draft/thread state and the
 * current Codex bot review receipt, fail-closed on missing, stale or partial data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function getReviewPrNumber(eventName, event) {
  if (eventName === "pull_request" || eventName === "pull_request_review") {
    const n = event.pull_request?.number ?? event.number;
    if (!Number.isSafeInteger(n) || n < 1) throw Error("Missing PR number");
    return n;
  }
  if (eventName === "merge_group") {
    const ref = event.merge_group?.head_ref ?? "";
    const match = /(?:^|\/)pr-(\d+)-/.exec(ref);
    const n = match && Number(match[1]);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw Error("Cannot establish exact PR in merge group; merge blocked");
    }
    return n;
  }
  throw Error("Review gate only accepts pull_request, pull_request_review and merge_group");
}

export function assessReview(pr, headSha, eventHead = null) {
  if (!pr || pr.state !== "OPEN" || pr.isDraft !== false) {
    return { state: "blocked", reason: "PR is closed or Draft" };
  }
  if (!/^[a-f0-9]{40}$/.test(headSha) || pr.headRefOid !== headSha ||
      (eventHead !== null && eventHead !== headSha)) {
    return { state: "blocked", reason: "PR head changed during validation" };
  }
  const threads = pr.reviewThreads;
  if (!threads || !Array.isArray(threads.nodes) ||
      threads.pageInfo?.hasNextPage !== false ||
      threads.nodes.some(t => t.isResolved !== true)) {
    return { state: "blocked", reason: "Unresolved or unverified review thread" };
  }
  const comments = pr.comments;
  if (!comments || !Array.isArray(comments.nodes)) {
    return { state: "blocked", reason: "Review status unavailable" };
  }
  const bot = comments.nodes.toReversed().find(c =>
    ["chatgpt-codex-connector[bot]", "chatgpt-codex-connector"].includes(c.author?.login) &&
    c.body?.includes("<!-- codex-review-state:v1 "));
  if (!bot) return { state: "pending", reason: "Awaiting Codex review receipt" };
  const match = /<!-- codex-review-state:v1 (\{[^\n]*\}) -->/.exec(bot.body);
  if (!match) return { state: "blocked", reason: "Malformed Codex review receipt" };
  let receipt;
  try { receipt = JSON.parse(match[1]); }
  catch { return { state: "blocked", reason: "Malformed Codex review status" }; }
  const summary = receipt?.code_review;
  if (summary?.commit_sha !== headSha) {
    return { state: "pending", reason: "Awaiting Codex review of current commit" };
  }
  if (summary.status === "running" || summary.status == null) {
    return { state: "pending", reason: "Codex review still running" };
  }
  if (summary.status !== "completed" ||
      summary.has_unresolved_findings !== false ||
      summary.has_any_findings !== false) {
    return { state: "blocked", reason: "Codex reported findings on the current SHA" };
  }
  // Optional Codex security reviews also block when requested, pending,
  // stale or reporting findings. A null status is no security review request.
  const security = receipt?.security_review;
  if (security?.status != null) {
    if (security.commit_sha !== headSha || security.status === "running") {
      return { state: "pending", reason: "Awaiting Codex security review of current SHA" };
    }
    if (security.status !== "completed" ||
        security.has_any_findings !== false ||
        security.has_unresolved_findings !== false) {
      return { state: "blocked", reason: "Codex security review reported findings" };
    }
  }
  return { state: "ready", reason: "Codex completed clean review on exact SHA; all threads resolved" };
}

const query = [
  "query($owner:String!,$repo:String!,$number:Int!){",
  "repository(owner:$owner,name:$repo){",
  "pullRequest(number:$number){",
  "isDraft state headRefOid",
  "reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}",
  "comments(last:100){nodes{body author{login}}pageInfo{hasPreviousPage}}",
  "}}}",
].join(" ");

export async function loadReviewPr(owner, repo, number, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables: { owner, repo, number } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("GitHub review API returned HTTP " + response.status);
  const json = await response.json();
  if (json.errors?.length) throw Error("GitHub review GraphQL returned errors");
  return json.data?.repository?.pullRequest ?? null;
}

export async function main(env = process.env) {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const n = getReviewPrNumber(env.GITHUB_EVENT_NAME, event);
  const eventHead = ["pull_request", "pull_request_review"].includes(env.GITHUB_EVENT_NAME) ?
    event.pull_request?.head?.sha ?? null : null;
  assert.match(owner ?? "", /^[a-zA-Z0-9_-]+$/);
  assert.match(repo ?? "", /^[a-zA-Z0-9_.-]+$/);
  assert.match(env.GITHUB_TOKEN ?? "", /\S/);
  for (let attempt = 0; attempt < 12; attempt++) {
    const pr = await loadReviewPr(owner, repo, n, env.GITHUB_TOKEN);
    const sha = pr?.headRefOid ?? "";
    const decision = assessReview(pr, sha, eventHead);
    if (decision.state === "ready") {
      console.log("Review gate PASS: PR #" + n + " on " + sha.slice(0, 12));
      return;
    }
    if (decision.state === "blocked") {
      throw Error("Review gate BLOCK: PR #" + n + " — " + decision.reason);
    }
    if (attempt === 11) throw Error("Review gate BLOCK: " + decision.reason);
    console.log("Review gate pending for PR #" + n + ": " + decision.reason);
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
