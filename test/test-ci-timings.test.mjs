import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allAttemptJobs, summarizeRun, summarizeRuns } from "../scripts/report-ci-timings.mjs";
import { selectProfiles } from "../scripts/fastfix-test-plan.mjs";

const time = (minute) => new Date(Date.UTC(2026, 10, 13, 10, minute)).toISOString();
const run = (id, name = "Release Readiness") => ({
  id, name, event: "pull_request", head_sha: "a".repeat(40),
  created_at: time(0), conclusion: "success",
});
const job = (name, start, end, conclusion = "success") => ({
  name, started_at: time(start), completed_at: time(end), conclusion,
});

test("measures elapsed wall time without summing parallel jobs twice", () => {
  const report = summarizeRun(run(10), [
    job("candidate", 2, 12),
    job("swarm", 12, 30),
    job("OIDC", 12, 17),
    job("skipped", 12, 11, "skipped"),
  ]);
  assert.equal(report.queuedMinutes, 2);
  assert.equal(report.observedWallMinutes, 28);
  assert.equal(report.runnerMinutes, 33);
  assert.deepEqual(report.slowestJob, { name: "swarm", minutes: 18 });
  assert.equal(report.skippedJobs, 1);
  assert.equal(report.untimedJobs, 0);
  assert.equal(report.jobs.length, 3);
});

test("invalid/skipped GitHub timestamps never produce negative durations", () => {
  const report = summarizeRun(run(11), [
    job("inverted", 30, 20),
    { name: "no times", conclusion: "success" },
    job("skip", 15, 14, "skipped"),
  ]);
  assert.equal(report.observedWallMinutes, null);
  assert.equal(report.queuedMinutes, null);
  assert.equal(report.runnerMinutes, 0);
  assert.equal(report.untimedJobs, 2);
  assert.equal(report.skippedJobs, 1);
});

test("per-workflow percentile is scoped and nearest-rank, not blended across workflows", () => {
  const report = summarizeRuns([
    { run: run(1), jobs: [job("A", 0, 3)] },
    { run: run(2), jobs: [job("B", 0, 10)] },
    { run: run(3), jobs: [job("C", 0, 20)] },
    { run: run(4, "Installer-Gated Release"), jobs: [job("publish", 0, 40)] },
  ]);
  assert.equal(report.sampledRuns, 4);
  assert.equal(report.workflows.length, 2);
  assert.equal(report.workflows[0].p50ObservedWallMinutes, 10);
  assert.equal(report.workflows[0].p90ObservedWallMinutes, 20);
  assert.equal(report.workflows[1].p50ObservedWallMinutes, 40);
});

test("offline CLI produces the same report and requires no GitHub credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-ci-timings-"));
  try {
    const input = join(root, "sample.json");
    writeFileSync(input, JSON.stringify([{ run: run(5), jobs: [job("candidate", 0, 8)] }]));
    const output = execFileSync(process.execPath, ["scripts/report-ci-timings.mjs", "--input", input, "--json"],
      { cwd: process.cwd(), encoding: "utf8", env: { PATH: process.env.PATH } });
    const report = JSON.parse(output);
    assert.equal(report.runs[0].observedWallMinutes, 8);
    assert.equal(report.runs[0].runnerMinutes, 8);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});


test("rerun-failed-jobs includes original successful jobs and separates retry gaps", () => {
  const rerun = { ...run(42), run_attempt: 2 };
  const jobs = [
    { ...job("candidate", 2, 12), run_attempt: 1 },
    { ...job("review", 12, 13, "failure"), run_attempt: 1 },
    { ...job("review", 49, 50), run_attempt: 2 },
  ];
  const result = summarizeRun(rerun, jobs);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.queuedMinutes, 2);
  assert.equal(result.observedWallMinutes, 48);
  assert.equal(result.activeAttemptWallMinutes, 12);
  assert.equal(result.retryIdleMinutes, 36);
  assert.equal(result.runnerMinutes, 12);
  assert.deepEqual(result.attempts.map((attempt) => attempt.observedWallMinutes), [11, 1]);
  assert.deepEqual(result.jobs.map((row) => row.attempt), [1, 1, 2]);
});

test("all-attempt API uses filter=all with pagination and fails on truncated history", async () => {
  const rerun = { ...run(73), run_attempt: 2 };
  const first = Array.from({ length: 100 }, (_, i) => ({
    ...job("candidate-" + i, 2, 3), run_attempt: 1,
  }));
  const last = { ...job("review", 49, 50), run_attempt: 2 };
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    return path.endsWith("page=1")
      ? { total_count: 101, jobs: first }
      : { total_count: 101, jobs: [last] };
  };
  const history = await allAttemptJobs("re-invertion/resourcePortal", rerun, "token", api);
  assert.equal(history.length, 101);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.includes("filter=all")));
  assert.ok(paths.every((path) => !path.includes("filter=latest")));
  await assert.rejects(
    () => allAttemptJobs("re-invertion/resourcePortal", rerun, "token",
      async () => ({ total_count: 1, jobs: [last] })),
    /Missing jobs for workflow attempt 1/,
  );
  await assert.rejects(
    () => allAttemptJobs("re-invertion/resourcePortal", rerun, "token",
      async () => ({ total_count: 101, jobs: [] })),
    /Incomplete GitHub jobs pagination/,
  );
  assert.throws(() => summarizeRun(rerun, [last]), /Missing jobs for workflow attempt 1/);
});

test("workflow percentiles use active attempt wall without manual rerun delay", () => {
  const rerun = { ...run(43), run_attempt: 2 };
  const report = summarizeRuns([
    { run: run(1), jobs: [job("normal", 0, 10)] },
    { run: rerun, jobs: [
      { ...job("first", 0, 2, "failure"), run_attempt: 1 },
      { ...job("retry", 58, 59), run_attempt: 2 },
    ] },
  ]);
  assert.equal(report.workflows[0].p50ActiveAttemptMinutes, 3);
  assert.equal(report.workflows[0].p90ActiveAttemptMinutes, 10);
  assert.equal(report.workflows[0].p90ObservedWallMinutes, 59);
});

test("new timing script and tests participate in workflow gate selection", () => {
  for (const path of ["scripts/report-ci-timings.mjs", "test/test-ci-timings.test.mjs"]) {
    assert.deepEqual(selectProfiles([path]).profiles, ["workflow"]);
  }
});
