#!/usr/bin/env node
// Conservatively classify rollback compatibility for a *specific* release range.
// This is not a SQL migration reversibility detector. A migration-changing
// release requires explicit, independently executed compatibility/restore tests.
import { execFileSync } from "node:child_process";

const DATA_PATHS = [
  "packages/resourceportal-api/prisma/migrations",
  "packages/resourceportal-api/prisma/schema.prisma",
  "packages/resourceportal-api/prisma/migrations_lock.toml",
];

export function rollbackAssessment(changedPaths, mode, previousVersion, targetCommit) {
  const changes = changedPaths.filter(Boolean);
  const schemaChanges = changes.filter((path) =>
    DATA_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + "/")),
  );
  const imageOnly = mode === "fastfix" && schemaChanges.length === 0;
  return {
    policy: imageOnly ? "image-only" : "none",
    reason: imageOnly
      ? "no-resourceportal-database-schema-changes"
      : schemaChanges.length
        ? "database-compatibility-not-verified"
        : "milestone-requires-verified-recovery",
    sourceVersion: previousVersion.replace(/^v/, ""),
    targetCommit,
  };
}

// A live smoke is necessary but not sufficient for irreversible SQL changes.
// Restrict the "tested" image rollback route to explicitly additive DDL:
// create new tables, indexes on those tables, nullable columns, and FKs from
// newly created tables. Newly added NOT NULL columns are only compatible when
// a safe constant default keeps writes from pre-upgrade runtimes valid.
// A destructive/data-writing statement or computed default fails closed.
export function assertExpandOnlyMigrationSql(sql) {
  const uncommented = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
  const statements = uncommented.split(";").map(x => x.trim()).filter(Boolean);
  if (!statements.length) throw new Error("Empty migration cannot certify schema compatibility");
  const newTables = new Set();
  for (const statement of statements) {
    const table = /^CREATE TABLE "([^"]+)"\s*\(/is.exec(statement);
    if (table) {
      newTables.add(table[1]);
      continue;
    }
    const alter = /^ALTER TABLE "([^"]+)"\s+([\s\S]+)$/i.exec(statement);
    if (alter) {
      // Only ADD COLUMN clauses may occur. Each clause is parsed independently
      // so a multi-column ALTER cannot conceal a destructive ALTER/DROP.
      // Commas inside expressions are unsupported and conservatively rejected.
      const clauses = alter[2].split(",").map(x => x.trim());
      if (clauses.every(clause => {
        const column = /^ADD COLUMN "[^"]+"\s+([\s\S]+)$/i.exec(clause);
        if (!column || /\bDROP\b|\bREFERENCES\b/i.test(column[1])) return false;
        if (!/\bNOT NULL\b/i.test(column[1])) return true;
        // PostgreSQL adds these with a constant default for both existing and
        // future rows; source-version services can continue inserting rows.
        // SQL functions, volatile defaults and unrecognized types fail closed.
        return /^(?:TEXT NOT NULL DEFAULT '(?:[^']|'')*'|JSONB NOT NULL DEFAULT '(?:[^']|'')*'::jsonb|INTEGER NOT NULL DEFAULT (?:0|[1-9][0-9]*))$/i.test(column[1].trim());
      })) continue;
    }
    const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX "[^"]+"\s+ON "([^"]+)"\s*\(/is.exec(statement);
    if (index && newTables.has(index[1])) continue;
    const fk = /^ALTER TABLE "([^"]+)"\s+ADD CONSTRAINT "[^"]+"\s+FOREIGN KEY\b/is.exec(statement);
    if (fk && newTables.has(fk[1])) continue;
    throw new Error("Release blocked: SQL migration is not an approved expand-only operation");
  }
}

/**
 * Published migration history must remain immutable. Independently verified
 * full source-DB restoration may authorize a DROP migration, unlike the
 * image-only/expand-only compatibility route. No static SQL analysis or
 * repository fixture can itself authorize destructive DDL.
 */
function verifyMigrationDiff(previous, head, verifiedSourceRestore) {
  const base = previous + "..." + head;
  const raw = execFileSync("git", [
    "diff", "--name-status", base, "--", "packages/resourceportal-api/prisma/migrations",
  ], { encoding: "utf8" }).trim();
  const changed = raw.split("\n").filter(Boolean);
  if (!changed.length) {
    throw new Error("Release blocked: schema was changed without a new migration");
  }
  for (const row of changed) {
    const [status, path] = row.split("\t");
    // Never alter an already-published migration: migration history is immutable.
    if (status !== "A" || !/^packages\/resourceportal-api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(path)) {
      throw new Error("Release blocked: existing Prisma migrations must remain immutable");
    }
    const sql = execFileSync("git", ["show", head + ":" + path], { encoding: "utf8" });
    if (!verifiedSourceRestore) assertExpandOnlyMigrationSql(sql);
  }
}

// Static diff eligibility is a prerequisite, not a substitute for a real
// rollback smoke. Schema/milestone can only claim "tested" if independent
// runtime evidence proves old images AND the exact source database snapshots
// can be restored after the upgrade. Old Prisma client compatibility alone is
// never sufficient: no new migration is allowed to survive a failed upgrade.
export function requireAutomaticRollback(result, evidence = null) {
  const validTarget = /^\d+\.\d+\.\d+$/.test(result.sourceVersion) &&
    /^[a-f0-9]{40}$/.test(result.targetCommit);
  if (validTarget && result.policy === "image-only" &&
      result.reason === "no-resourceportal-database-schema-changes") return result;

  const verified = validTarget &&
    result.policy === "none" &&
    ["database-compatibility-not-verified", "milestone-requires-verified-recovery"].includes(result.reason) &&
    evidence?.kind === "real-upgrade-and-restore" &&
    evidence.sourceVersion === result.sourceVersion &&
    evidence.targetCommit === result.targetCommit &&
    Number.isSafeInteger(evidence.workflowRunId) && evidence.workflowRunId > 0 &&
    evidence.actualDatabaseMigration === true &&
    evidence.previousApiReadWriteAfterRollback === true &&
    evidence.previousApiRuntimeReadyAfterRollback === true &&
    evidence.injectedHealthFailure === true &&
    evidence.previousImagesRestored === true &&
    evidence.databaseSnapshotVerified === true &&
    evidence.databaseSnapshotRestored === true &&
    evidence.restoredSourceSchema === true &&
    evidence.zitadelDatabaseRestored === true &&
    evidence.zitadelSourceRuntimeReadyAfterRollback === true &&
    evidence.zitadelSourceEventstoreVerified === true &&
    evidence.candidateZitadelRuntimeReadyBeforeRollback === true &&
    /^ghcr\.io\/zitadel\/zitadel@sha256:[a-f0-9]{64}$/.test(evidence.candidateZitadelImage) &&
    /^ghcr\.io\/zitadel\/zitadel@sha256:[a-f0-9]{64}$/.test(evidence.sourceZitadelImage) &&
    // A PR must not reuse evidence issued in a different workflow run.
    (!process.env.GITHUB_RUN_ID || evidence.workflowRunId === Number(process.env.GITHUB_RUN_ID));
  if (verified) {
    return {
      ...result,
      policy: "tested",
      reason: "verified-recovery-test",
      rollbackEvidence: {
        kind: evidence.kind,
        workflowRunId: evidence.workflowRunId,
        sourceVersion: evidence.sourceVersion,
        databaseSnapshotRestored: true,
        restoredSourceSchema: true,
        zitadelDatabaseRestored: true,
        zitadelSourceRuntimeReadyAfterRollback: true,
        zitadelSourceEventstoreVerified: true,
        candidateZitadelRuntimeReadyBeforeRollback: true,
        candidateZitadelImage: evidence.candidateZitadelImage,
        sourceZitadelImage: evidence.sourceZitadelImage,
      },
    };
  }
  throw new Error(
    "Release blocked: automatic rollback is not verified for this source/target. " +
    "Schema-changing or milestone releases require a separately tested restore protocol.",
  );
}

function option(flag) {
  const i = process.argv.indexOf(flag);
  return i < 0 ? null : process.argv[i + 1];
}

if (process.argv[1]?.endsWith("/release-rollback-policy.mjs")) {
  const previous = option("--previous-tag");
  const head = option("--head");
  const mode = option("--mode");
  if (!previous || !head || !["fastfix", "milestone"].includes(mode)) {
    throw new Error("--previous-tag, --head and --mode are required");
  }
  // Fail closed on any Git error, unknown history, or missing comparison tag.
  const paths = execFileSync("git", [
    "diff", "--name-only", previous + "..." + head, "--",
  ], { encoding: "utf8" }).split("\n").filter(Boolean);
  const commit = execFileSync("git", ["rev-parse", head + "^{commit}"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid target commit");
  const assessment = rollbackAssessment(paths, mode, previous, commit);
  const evidenceFile = option("--verified-evidence-file");
  // Evidence is generated only after real CI upgrade/rollback, never from a
  // checked-in fixture or static SQL heuristic. Without it, fail closed.
  let evidence = null;
  if (evidenceFile) {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const trustedRoot = process.env.RUNNER_TEMP;
    if (process.env.GITHUB_ACTIONS === "true" &&
        (!trustedRoot || !resolve(evidenceFile).startsWith(resolve(trustedRoot) + "/"))) {
      throw new Error("Rollback evidence must reside in RUNNER_TEMP");
    }
    evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
  }
  const result = process.argv.includes("--require-automatic")
    ? requireAutomaticRollback(assessment, evidence)
    : assessment;
  if (assessment.reason === "database-compatibility-not-verified" && evidence) {
    // A destructive migration can be authorized ONLY after all independently
    // generated exact-run restore evidence was accepted by requireAutomaticRollback.
    verifyMigrationDiff(previous, head, result.policy === "tested");
  }
  console.log(JSON.stringify(result));
  const output = option("--github-output");
  if (output) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(output, [
      "rollback_policy=" + result.policy,
      "rollback_reason=" + result.reason,
      "rollback_source_version=" + result.sourceVersion,
      "rollback_target_commit=" + result.targetCommit,
      "",
    ].join("\n"));
  }
}
