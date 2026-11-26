"use strict";
// Fail-closed CI diagnostics. Never serialize exception messages or stacks:
// Playwright navigation errors can include user_code, OAuth codes and URLs.
const allowedStages = new Set([
  "initialization", "issuer-discovery", "synthetic-fixtures",
  "login-v2-pkce", "device-no-implicit-consent",
  "device-explicit-deny", "device-explicit-allow",
  "device-allow-request", "device-allow-entry", "device-allow-controls",
  "device-allow-pending", "device-allow-decision", "device-allow-token-poll",
  "device-allow-token-verify",
]);
const categories = new Set(["AssertionError", "TimeoutError", "TypeError"]);
function safeFailureLine(stage, error) {
  const cleanStage = allowedStages.has(stage) ? stage : "unclassified";
  const name = error && typeof error === "object" ? error.name : undefined;
  const cleanCategory = categories.has(name) ? name : "OtherError";
  return "BLOCKED: real isolated Login V2 consent E2E: stage=" +
    cleanStage + "; error=" + cleanCategory + "; details suppressed";
}
module.exports = { safeFailureLine };
