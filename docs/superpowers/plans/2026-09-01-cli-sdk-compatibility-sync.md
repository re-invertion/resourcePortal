# ResourcePortal CLI / SDK Compatibility Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore full public management API parity for the ResourcePortal SDK and CLI without changing backend semantics.

**Architecture:** Keep the existing client and command surface backward-compatible. Extend the SDK through a compatibility entry point that overrides transport behavior and adds missing resource groups. Extend the CLI through a thin dispatcher that handles newly added command groups and delegates existing commands to the current implementation. Regression tests become the contract preventing future drift.

**Tech Stack:** TypeScript, Node.js 22, built-in `node:test`, npm workspaces, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-01-cli-sdk-compatibility-sync-design.md`

---

### Task 1: Add failing SDK compatibility tests

**Files:**
- Create: `packages/resourceportal-sdk/test/compatibility.test.js`
- Modify: `packages/resourceportal-sdk/package.json`

Write Node tests that use a recording `fetchImpl` and require the package root. Cover representative calls from platform billing, Swarm/RemoteLocation, storage backends, Operations, platform maintenance, tenant/platform OAuth applications, tenant/platform service identities, platform identity providers, audit query/export and metrics. Also verify correlation/request headers, text responses and structured errors.

Run CI and verify RED because current package does not expose the new resource groups and text transport still attempts JSON parsing.

### Task 2: Add failing CLI discoverability tests

**Files:**
- Create: `packages/resourceportal-cli/test/compatibility.test.js`
- Modify: `packages/resourceportal-cli/package.json`

Use the package's configured `rp` bin in tests and assert global help exposes the newly supported groups and correlation/request ID flags. Verify RED on the current CLI.

### Task 3: Implement SDK transport compatibility

**Files:**
- Create: `packages/resourceportal-sdk/src/full.ts`
- Modify: `packages/resourceportal-sdk/package.json`

Export a backward-compatible `ResourcePortalClient` subclass and improved `ResourcePortalApiError`. Override `request` to support query parameters, automatic JSON/text response handling, client/per-request `x-correlation-id` and `x-request-id`, and structured error metadata. Preserve existing authentication and idempotency behavior.

Run SDK tests and verify transport tests turn GREEN.

### Task 4: Implement missing SDK resource groups

**Files:**
- Modify: `packages/resourceportal-sdk/src/full.ts`

Add dedicated modules for each resource family in the approved spec. Every method must use encoded path parameters and canonical API HTTP methods. Audit list/export must serialize supported query fields; metrics must return text.

Run SDK tests and root lint/build.

### Task 5: Implement CLI compatibility dispatcher

**Files:**
- Create: `packages/resourceportal-cli/src/full-cli.ts`
- Modify: `packages/resourceportal-cli/package.json`

Add a dispatcher for new groups while preserving legacy commands. Global `--correlation-id` and `--request-id` must be propagated through the SDK. Existing config (`~/.resourceportal/config.json`) and output modes remain valid. Build output must keep the existing `rp`/`resourceportal` bin contract.

Run CLI tests and verify GREEN.

### Task 6: Document the synchronized public surface

**Files:**
- Modify: `packages/resourceportal-sdk/README.md`
- Modify: `packages/resourceportal-cli/README.md`

Document the added resource groups, text responses, correlation/request IDs, and the explicit exclusion of internal endpoints.

### Task 7: Full verification and merge

Run GitHub Actions CI on the final PR head. Inspect changed files/diff and verify all required checks are green. Merge only the exact verified head SHA.

### Task 8: Update ResourcePortal Wiki after verified merge

Patch the Wiki `Implementation Stages` and the relevant CLI/SDK documentation to record the compatibility sync, exact PR/head/merge evidence, newly exposed modules/commands and drift-prevention tests. Do not rewrite unrelated Wiki content.
