Resource Portal is a monorepo for the Resource Portal backend, TypeScript SDK, and command line interface.

## Packages

```text
packages/
  resourceportal-api/   NestJS API, Prisma schema, deployment worker
  resourceportal-sdk/   TypeScript SDK for the public HTTP API
  resourceportal-cli/   rp/resourceportal CLI built on top of the SDK
```

## Root Commands

```bash
npm install
npm run build
npm run lint
npm test
npm run api:start
npm run api:worker:deployments
npm run api:smoke:deploy
npm run cli -- --help
```

## Local Infrastructure

`docker-compose.yml` starts local PostgreSQL and ZITADEL dependencies. Root `.env` is used by Docker Compose. The API package also falls back to reading `../../.env` when it is run from `packages/resourceportal-api`.

```bash
docker compose up -d postgres
npm run api:prisma:migrate
npm run api:db:seed
npm run api:start
```

## Production Shape

The Docker image builds the API package and can run either process:

```bash
node dist/src/main.js
node dist/src/internal/deployment-worker.runner.js
```

API handles HTTP requests and writes deployment intent to PostgreSQL. Worker claims queued deployments and performs Docker Swarm operations.

Package documentation:

```text
packages/resourceportal-api/README.md
packages/resourceportal-sdk/README.md
packages/resourceportal-cli/README.md
```
