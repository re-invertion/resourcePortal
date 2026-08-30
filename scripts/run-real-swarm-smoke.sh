#!/usr/bin/env bash
set -euo pipefail

bash scripts/validate-swarm-ci.sh
npm run api:smoke:deploy
