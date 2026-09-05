#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
contains(){ local f="$1" n="$2" name="$3"; grep -Fq -- "$n" "$f" && pass "$name" || fail "$name"; }
not_contains(){ local f="$1" n="$2" name="$3"; if grep -Fq -- "$n" "$f"; then fail "$name"; else pass "$name"; fi; }

api_pkg="$repo_root/packages/resourceportal-api/package.json"
api_docker="$repo_root/Dockerfile"
web_docker="$repo_root/packages/resourceportal-web/Dockerfile"

node - "$api_pkg" <<'EOF_NODE' || fail "Prisma CLI is a production API dependency"
const fs=require('node:fs');
const pkg=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if (pkg.dependencies?.prisma !== '6.12.0') process.exit(1);
EOF_NODE
[[ -f "$web_docker" ]] && pass "Web production Dockerfile exists" || fail "Web production Dockerfile exists"
if [[ -f "$web_docker" ]]; then
  contains "$web_docker" 'RUN npm run build' "Web image builds production assets"
  contains "$web_docker" 'ENV NODE_ENV=production' "Web runtime forces production mode"
  contains "$web_docker" 'CMD ["node", "server.mjs"]' "Web runtime starts SSR server"
  not_contains "$web_docker" 'npm run dev' "Web runtime does not start Vite dev mode"
fi
contains "$api_docker" 'COPY --from=build /app/packages/resourceportal-api/dist ./dist' "API image contains compiled runners"
not_contains "$api_docker" 'CMD ["ts-node"' "API runtime does not depend on ts-node"


postgres_dockerfile="$repo_root/packages/resourceportal-postgres/Dockerfile"
[[ -f "$postgres_dockerfile" ]] && pass 'PostgreSQL fencing runtime Dockerfile exists' || fail 'PostgreSQL fencing runtime Dockerfile exists'
contains "$postgres_dockerfile" 'util-linux' 'PostgreSQL fencing image installs flock provider'
contains "$postgres_dockerfile" 'resourceportal-postgres-fence' 'PostgreSQL fencing image installs wrapper'

fence_script="$repo_root/packages/resourceportal-postgres/postgres-fence.sh"
not_contains "$fence_script" '.holder' 'PostgreSQL fencing does not leave stale holder marker files'
contains "$fence_script" 'flock -n 9' 'PostgreSQL fencing remains fail-closed on exclusive lock'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All production packaging tests passed.\n'
