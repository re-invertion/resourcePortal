Resource Portal is a monorepo for the Resource Portal backend, TypeScript SDK, command line interface, and Web Console.

## Packages

```text
packages/
  resourceportal-api/   NestJS API, Prisma schema, unified Worker
  resourceportal-sdk/   TypeScript SDK for the public HTTP API
  resourceportal-cli/   rp/resourceportal CLI built on top of the SDK
  resourceportal-web/   React + TypeScript SSR/MPA Web Console
```

## Root Commands

```bash
npm install
npm run build
npm run lint
npm test
npm run api:start
npm run api:worker
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

## Supported testing environments

CI validates installer contracts, production image builds, the OIDC federation integration, and the Docker Swarm browser smoke against the dedicated test environment. Local development uses Docker Compose and the commands above.

## Production Shape

The Docker image builds the API package and can run either process:

```bash
node dist/src/main.js
node dist/src/worker.runner.js
```

API handles HTTP requests and writes deployment intent to PostgreSQL. Worker claims queued deployments and performs Docker Swarm operations.

Package documentation:

```text
packages/resourceportal-api/README.md
packages/resourceportal-sdk/README.md
packages/resourceportal-cli/README.md
```

## Control-plane backup

`npm run backup:control-plane` creates a PostgreSQL dump, an optional config
archive, and an archive of the encrypted AppGroup Secret store. Every artifact
is covered by `manifest.sha256`; plaintext Secret values are never exported.
Pause API writes and the unified Worker for the duration of backup so the
database snapshot and encrypted Secret archive describe the same point in time.

```bash
DATABASE_URL=postgresql://... \
RESOURCE_STORAGE_BASE_PATH=/srv/resource-portal/storage \
RESOURCE_PORTAL_BACKUP_DIR=/srv/resource-portal-backups \
npm run backup:control-plane
```

Restore requires an explicit destructive-operation confirmation. When present,
`secrets.tar.gz` is restored into `${RESOURCE_STORAGE_BASE_PATH}/secrets` together with
the database state.

```bash
DATABASE_URL=postgresql://... \
RESOURCE_STORAGE_BASE_PATH=/srv/resource-portal/storage \
RESOURCE_PORTAL_RESTORE_CONFIRM=resource-portal \
npm run restore:control-plane -- /srv/resource-portal-backups/resource-portal-TIMESTAMP
```
