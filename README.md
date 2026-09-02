Resource Portal is a monorepo for the Resource Portal backend, TypeScript SDK, command line interface, and Web Console.

## Packages

```text
packages/
  resourceportal-api/   NestJS API, Prisma schema, deployment worker
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

## GitHub Codespaces Preview

The repository includes a one-click development preview in `.devcontainer/devcontainer.json`. From GitHub choose **Code → Codespaces → Create codespace**. The container installs dependencies, prepares a local runtime, starts PostgreSQL, applies Prisma migrations, seeds the core roles and a development administrator, starts the API and workers, initializes a single-node Docker Swarm when available, and opens the Web Console on private forwarded port `5173`.

The preview creates a `codespace-demo` tenant with development quota and credits so the functional Web Console can be explored immediately. Runtime state and logs are stored under the ignored `var/codespaces/` directory.

The Codespaces preview intentionally uses `AUTH_MODE=dev`. The Web proxy injects the fixed development identity only when `NODE_ENV` is not `production`; production mode never enables this behavior. ZITADEL/OIDC login, CephFS/NFS-Ganesha storage, production Traefik ingress, certificates, and multi-node infrastructure are not simulated by this preview.

To restart the preview manually inside a Codespace:

```bash
bash scripts/codespace-start.sh
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

## Control-plane backup

`npm run backup:control-plane` creates a PostgreSQL dump, an optional config
archive, and an archive of the encrypted AppGroup Secret store. Every artifact
is covered by `manifest.sha256`; plaintext Secret values are never exported.
Pause API writes and deployment workers for the duration of backup so the
database snapshot and NFS archive describe the same point in time.

```bash
DATABASE_URL=postgresql://... \
RESOURCE_SECRET_STORAGE_ROOT=/rp/secrets \
RESOURCE_PORTAL_BACKUP_DIR=/srv/resource-portal-backups \
npm run backup:control-plane
```

Restore requires an explicit destructive-operation confirmation. When present,
`secrets.tar.gz` is restored into `RESOURCE_SECRET_STORAGE_ROOT` together with
the database state.

```bash
DATABASE_URL=postgresql://... \
RESOURCE_SECRET_STORAGE_ROOT=/rp/secrets \
RESOURCE_PORTAL_RESTORE_CONFIRM=resource-portal \
npm run restore:control-plane -- /srv/resource-portal-backups/resource-portal-TIMESTAMP
```
