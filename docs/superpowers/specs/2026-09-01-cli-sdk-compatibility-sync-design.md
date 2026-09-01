# CLI / SDK Compatibility Sync Design

## Status

Approved on 2026-09-01. The selected approach is a bounded compatibility sync of the existing ResourcePortal SDK and CLI against the current public management API. Backend semantics and endpoint contracts are not changed.

## Goal

Bring `@resource-portal/sdk` and `@resource-portal/cli` back into parity with public API capabilities added after the original CLI/SDK stage, while preserving all existing SDK methods and CLI commands.

## Included API surface

The sync must add dedicated SDK modules and CLI commands for public management endpoints that are currently missing:

- platform billing: price lists, vouchers, payments, refunds and corrections;
- platform infrastructure: Swarm cluster read/reconcile and RemoteLocation read/maintenance;
- platform storage backends: list/get/validate/maintenance;
- tenant Operations / Jobs: list/get/events/retry;
- platform maintenance: read/update;
- tenant OAuth Applications: CRUD and credential rotation;
- platform OAuth Applications: CRUD and credential rotation;
- tenant Service Identities: CRUD and credential rotation;
- platform Service Identities: CRUD and credential rotation;
- platform Identity Providers: CRUD;
- observability metrics (`GET /metrics`);
- complete tenant audit-log list filters and export.

Existing SDK/CLI areas remain supported unchanged.

## Explicit exclusions

- `/internal/*` endpoints are not public SDK/CLI surface.
- Controllers that are semantically internal even when their route does not start with `/internal` are excluded. In particular `/users` is guarded by `InternalAuthGuard` and documented by the API as an internal endpoint.
- No backend API or persistence model changes.
- No OpenAPI client-generation migration in this change.

## Transport compatibility

The SDK transport must:

- preserve Bearer and dev-user authentication;
- preserve idempotency keys;
- support `x-correlation-id` and `x-request-id` at client and per-request level;
- support query parameters without string concatenation in resource methods;
- parse JSON responses as before;
- return text responses without attempting `JSON.parse`, including Prometheus metrics and audit exports;
- preserve structured API error information and expose `code`, `details`, `requestId` and `correlationId` when present.

## CLI compatibility

The CLI must preserve existing commands/configuration and add dedicated commands for the new SDK surface. Global correlation/request IDs must be accepted and propagated without requiring command-specific flags.

## Drift prevention

Regression tests must exercise representative routes from every newly exposed resource family and verify transport behavior for query serialization, text responses and correlation headers. CLI help tests must verify that the newly supported command groups remain discoverable.
