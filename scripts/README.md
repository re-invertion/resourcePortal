# Integration test scripts

- `validate-swarm-ci.sh` checks that required environment variables, the Resource Portal API, and an active Docker Swarm manager are available.
- `run-real-swarm-smoke.sh` runs the reusable real-Swarm preflight and then executes `npm run api:smoke:deploy`.

These scripts are intentionally CI-provider agnostic. GitHub Actions uses them, but they can also be run from a developer machine or a self-hosted multi-node Swarm test environment.
