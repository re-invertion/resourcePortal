#!/usr/bin/env node
/**
 * Read-only GitHub Actions timing report. Does not run tests or change release
 * policy. CI timing must be measured before gates are optimized or removed.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/report-ci-timings.mjs --repo owner/repo --limit 10
 *   node scripts/report-ci-timings.mjs --input timings.json --json
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKFLOWS = ["release-readiness.yml", "ci.yml", "release.yml"];
const VALID_REPO = /^[a-z\d_.-]+\/[a-z\d_.-]+$/i;
const MINUTE = 60_000;

function timestamp(value) {
  const date = Date.parse(value ?? "");
  return Number.isFinite(date) ? date : null;
}

function minutes(start, end) {
  if (start === null || end === null || end < start) return null;
  return Math.round(((end - start) / MINUTE) * 100) / 100;
}

function percentile(values, percent) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(percent * ordered.length) - 1)];
}

function attemptNumber(job) {
  return Number.isSafeInteger(job?.run_attempt) && job.run_attempt > 0 ? job.run_attempt : null;
}

export function summarizeRun(run, jobs) {
  if (!Number.isSafeInteger(run.id) || !Array.isArray(jobs)) {
    throw new Error("Invalid workflow run or jobs payload");
  }
  const expectedAttempts = Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    ? run.run_attempt
    : Math.max(1, ...jobs.map((job) => attemptNumber(job) ?? 1));
  const byAttempt = new Map();
  for (const job of jobs) {
    const attempt = attemptNumber(job);
    if (expectedAttempts > 1 && (attempt === null || attempt > expectedAttempts)) {
      throw new Error("Incomplete or invalid GitHub workflow attempt metadata");
    }
    const number = attempt ?? 1;
    const group = byAttempt.get(number) ?? [];
    group.push(job);
    byAttempt.set(number, group);
  }
  if (expectedAttempts > 1) {
    for (let number = 1; number <= expectedAttempts; number++) {
      if (!byAttempt.has(number)) throw new Error("Missing jobs for workflow attempt " + number);
    }
  }

  const timed = jobs.flatMap((job) => {
    if (job.conclusion === "skipped") return [];
    const start = timestamp(job.started_at);
    const end = timestamp(job.completed_at);
    const durationMinutes = minutes(start, end);
    if (durationMinutes === null) return [];
    return [{ name: job.name ?? "(unnamed)", conclusion: job.conclusion ?? null,
      attempt: attemptNumber(job) ?? 1, start, end, minutes: durationMinutes }];
  });
  const attemptStats = [...byAttempt].sort(([a], [b]) => a - b).map(([number, group]) => {
    const measured = timed.filter((job) => job.attempt === number);
    const first = measured.length ? Math.min(...measured.map((job) => job.start)) : null;
    const last = measured.length ? Math.max(...measured.map((job) => job.end)) : null;
    return {
      number,
      observedWallMinutes: minutes(first, last),
      runnerMinutes: Math.round(measured.reduce((sum, job) => sum + job.minutes, 0) * 100) / 100,
      jobCount: group.length,
      skippedJobs: group.filter((job) => job.conclusion === "skipped").length,
    };
  });
  const firstStart = timed.length ? Math.min(...timed.map((job) => job.start)) : null;
  const lastEnd = timed.length ? Math.max(...timed.map((job) => job.end)) : null;
  const lifecycleWall = minutes(firstStart, lastEnd);
  const activeAttemptWall = timed.length
    ? Math.round(attemptStats.reduce((sum, item) => sum + (item.observedWallMinutes ?? 0), 0) * 100) / 100
    : null;
  const earliestCreated = timestamp(run.created_at);
  const slowestJob = [...timed].sort((a, b) => b.minutes - a.minutes)[0];
  return {
    id: run.id,
    workflow: run.name ?? run.workflow_id ?? "unknown",
    event: run.event ?? null,
    headSha: run.head_sha ?? null,
    conclusion: run.conclusion ?? null,
    attemptCount: expectedAttempts,
    attempts: attemptStats,
    queuedMinutes: minutes(earliestCreated, firstStart),
    observedWallMinutes: lifecycleWall,
    activeAttemptWallMinutes: activeAttemptWall,
    retryIdleMinutes: lifecycleWall === null || activeAttemptWall === null
      ? null : Math.max(0, Math.round((lifecycleWall - activeAttemptWall) * 100) / 100),
    runnerMinutes: Math.round(timed.reduce((sum, job) => sum + job.minutes, 0) * 100) / 100,
    slowestJob: slowestJob ? { name: slowestJob.name, minutes: slowestJob.minutes } : null,
    skippedJobs: jobs.filter((job) => job.conclusion === "skipped").length,
    untimedJobs: jobs.length - timed.length - jobs.filter((job) => job.conclusion === "skipped").length,
    jobs: timed.map(({ name, conclusion, attempt, minutes: durationMinutes }) =>
      ({ name, conclusion, attempt, minutes: durationMinutes })),
  };
}

export function summarizeRuns(samples) {
  if (!Array.isArray(samples)) throw new Error("Expected array of {run, jobs} samples");
  const runs = samples.map(({ run, jobs }) => summarizeRun(run, jobs));
  const grouped = new Map();
  for (const run of runs) {
    const bucket = grouped.get(run.workflow) ?? [];
    bucket.push(run);
    grouped.set(run.workflow, bucket);
  }
  return {
    sampledRuns: runs.length,
    workflows: [...grouped].map(([workflow, matches]) => {
      const values = matches.map((run) => run.observedWallMinutes).filter((n) => n !== null);
      const activeValues = matches.map((run) => run.activeAttemptWallMinutes).filter((n) => n !== null);
      const bottlenecks = matches.flatMap((run) => run.slowestJob ? [run.slowestJob] : []);
      bottlenecks.sort((a, b) => b.minutes - a.minutes);
      return {
        workflow,
        sampledRuns: matches.length,
        p50ObservedWallMinutes: percentile(values, 0.5),
        p90ObservedWallMinutes: percentile(values, 0.9),
        p50ActiveAttemptMinutes: percentile(activeValues, 0.5),
        p90ActiveAttemptMinutes: percentile(activeValues, 0.9),
        slowestObservedJob: bottlenecks[0] ?? null,
      };
    }),
    runs,
  };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(flag + " requires a value");
  return args[i + 1];
}

function options(args) {
  const repo = argValue(args, "--repo") ?? "re-invertion/resourcePortal";
  if (!VALID_REPO.test(repo)) throw new Error("--repo must be owner/name");
  const limit = Number(argValue(args, "--limit") ?? 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be 1..50");
  const workflows = (argValue(args, "--workflows") ?? DEFAULT_WORKFLOWS.join(",")).split(",");
  if (workflows.some((workflow) => !/^[a-z\d_.-]+\.ya?ml$/i.test(workflow))) {
    throw new Error("--workflows must be comma-separated YAML filenames");
  }
  return { repo, limit, workflows, input: argValue(args, "--input"), json: args.includes("--json") };
}

async function github(path, token) {
  const response = await fetch("https://api.github.com" + path, {
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "resourceportal-ci-timings" },
  });
  if (!response.ok) throw new Error("GitHub API request failed (" + response.status + ") for " + path);
  return response.json();
}

// GitHub defaults /jobs to filter=latest, omitting successful work from
// earlier attempts when only failed jobs are rerun. Require filter=all and
// check the complete pagination and attempt history before calculating timings.
export async function allAttemptJobs(repo, run, token, api = github) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const path = "/repos/" + repo + "/actions/runs/" + run.id +
      "/jobs?filter=all&per_page=100&page=" + page;
    const result = await api(path, token);
    const total = result?.total_count;
    if (!Array.isArray(result?.jobs) || !Number.isSafeInteger(total) || total < 0) {
      throw new Error("Invalid complete GitHub jobs response for run " + run.id);
    }
    jobs.push(...result.jobs);
    if (jobs.length > total) throw new Error("GitHub jobs exceeded reported total");
    if (jobs.length === total) {
      // A rerun-failed-jobs attempt contains only the rerun jobs, not all the
      // original successful ones. Every started attempt still has a job row.
      if (Number.isSafeInteger(run.run_attempt) && run.run_attempt > 1) {
        const attempts = new Set(jobs.map((job) => attemptNumber(job)));
        for (let number = 1; number <= run.run_attempt; number++) {
          if (!attempts.has(number)) throw new Error("Missing jobs for workflow attempt " + number);
        }
      }
      return jobs;
    }
    if (!result.jobs.length) throw new Error("Incomplete GitHub jobs pagination");
  }
  throw new Error("GitHub jobs history exceeds safe pagination limit");
}

async function sampleGithub({ repo, workflows, limit }) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN; or pass --input for offline analysis");
  const samples = [];
  for (const workflow of workflows) {
    const query = "/repos/" + repo + "/actions/workflows/" +
      encodeURIComponent(workflow) + "/runs?status=completed&per_page=" + limit;
    const payload = await github(query, token);
    if (!Array.isArray(payload.workflow_runs)) throw new Error("Invalid workflow_runs response");
    for (const run of payload.workflow_runs) {
      samples.push({ run, jobs: await allAttemptJobs(repo, run, token) });
    }
  }
  return samples;
}

function format(report) {
  const rows = [
    "Workflow | runs | p50 active attempts | p90 active attempts | p50 lifecycle | slowest observed job",
    "--- | ---: | ---: | ---: | ---: | ---",
  ];
  for (const workflow of report.workflows) {
    const slowest = workflow.slowestObservedJob;
    rows.push([workflow.workflow, workflow.sampledRuns,
      workflow.p50ActiveAttemptMinutes ?? "n/a",
      workflow.p90ActiveAttemptMinutes ?? "n/a",
      workflow.p50ObservedWallMinutes ?? "n/a",
      slowest ? slowest.name + " (" + slowest.minutes + " min)" : "n/a"].join(" | "));
  }
  return rows.join("\n") +
    "\n\nActive attempt wall sums elapsed time within every attempt; lifecycle wall also includes gaps between reruns." +
    "\nRunner-minutes sum job durations across all attempts (including parallel overlap)." +
    "\nQueue delay is measured from original run creation, never from a retry." +
    "\nA job duration does not identify duplicate test commands or prove end-to-end release latency.";
}

async function main() {
  const opts = options(process.argv.slice(2));
  const samples = opts.input ? JSON.parse(readFileSync(opts.input, "utf8")) : await sampleGithub(opts);
  const report = summarizeRuns(samples);
  process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + "\n" : format(report) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
