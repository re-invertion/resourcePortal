# Real Docker Swarm CI

The `Real Docker Swarm Integration` GitHub Actions workflow runs Resource Portal against an actual single-node Docker Swarm manager on every pull request and push to `main`.

It validates the integration path that unit tests cannot cover:

- PostgreSQL migrations and RBAC seed,
- Resource Portal API startup in dev-auth mode,
- Docker Swarm manager availability,
- tenant, quota, AppGroup, SingleApp and volume creation,
- variables, configs and secret runtime configuration,
- deployment through the real deployment worker,
- Docker stack creation and rollout,
- stop/start/restart runtime operations,
- rollback execution,
- cleanup of Resource Portal stacks after the smoke test.

The workflow uploads the API log as an artifact even when the test fails. The existing `api:smoke:deploy` command remains the reusable integration-test entry point, so the same test can be run on a developer machine or on a self-hosted runner connected to a larger Swarm.

## Local prerequisites

1. A PostgreSQL database matching `DATABASE_URL`.
2. An active Docker Swarm manager in the selected `DOCKER_CONTEXT`.
3. An active Resource Portal user passed through `SMOKE_USER_ID`.
4. Writable `RESOURCE_STORAGE_ROOT` and `RESOURCE_SECRET_STORAGE_ROOT` paths.
5. The API running at `RESOURCE_PORTAL_API_URL`.

Then run:

```bash
npm run api:smoke:deploy
```

For multi-node testing, keep the same smoke command and point `DOCKER_CONTEXT` at a manager of the target test Swarm. This keeps the test harness independent from GitHub Actions and allows extending the CI later with dedicated self-hosted multi-node runners.
