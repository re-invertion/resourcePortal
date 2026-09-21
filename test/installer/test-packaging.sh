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
  contains "$web_docker" 'COPY packages/resourceportal-web/public ./public' "Web image includes public brand assets before Vite build"
  contains "$repo_root/packages/resourceportal-web/server.mjs" '[".png", "image/png"]' "Web server serves PNG brand assets with image/png MIME type"
  contains "$repo_root/packages/resourceportal-web/server.mjs" '[".webmanifest", "application/manifest+json; charset=utf-8"]' "Web server serves the PWA manifest with the correct MIME type"
  [[ -f "$repo_root/packages/resourceportal-web/public/manifest.webmanifest" ]] && pass "Web PWA manifest is packaged" || fail "Web PWA manifest is packaged"
  [[ -f "$repo_root/packages/resourceportal-web/public/service-worker.js" ]] && pass "Web PWA service worker is packaged" || fail "Web PWA service worker is packaged"
  contains "$repo_root/packages/resourceportal-web/index.html" 'rel="manifest" href="/manifest.webmanifest"' "Web document advertises the PWA manifest"
  contains "$repo_root/packages/resourceportal-web/src/entry-client.tsx" 'navigator.serviceWorker.register("/service-worker.js"' "Web client registers the production service worker"
  not_contains "$repo_root/packages/resourceportal-web/public/service-worker.js" '/api/' "PWA service worker does not define API caching routes"
  contains "$repo_root/packages/resourceportal-web/public/service-worker.js" 'url.pathname.startsWith("/assets/")' "PWA service worker caches only hashed application assets"
  contains "$repo_root/packages/resourceportal-web/public/service-worker.js" 'url.pathname.startsWith("/brand/")' "PWA service worker supports brand asset caching"
  node - "$repo_root/packages/resourceportal-web/public/manifest.webmanifest" "$repo_root/packages/resourceportal-web/public" <<'EOF_PWA' || fail "PWA manifest contains real 192px and 512px PNG icons"
const fs = require("node:fs");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const root = process.argv[3];
for (const size of [192, 512]) {
  const icon = manifest.icons?.find((item) => item.type === "image/png" && item.sizes === `${size}x${size}`);
  if (!icon) process.exit(1);
  const file = path.join(root, icon.src.replace(/^\//, ""));
  const data = fs.readFileSync(file);
  if (data.toString("hex", 0, 8) !== "89504e470d0a1a0a") process.exit(1);
  if (data.readUInt32BE(16) !== size || data.readUInt32BE(20) !== size) process.exit(1);
}
EOF_PWA
  if [[ $? -eq 0 ]]; then pass "PWA manifest contains real 192px and 512px PNG icons"; fi
  contains "$web_docker" 'ENV NODE_ENV=production' "Web runtime forces production mode"
  contains "$web_docker" 'CMD ["node", "server.mjs"]' "Web runtime starts SSR server"
  not_contains "$web_docker" 'npm run dev' "Web runtime does not start Vite dev mode"
not_contains "$web_docker" '/app/packages/resourceportal-web/node_modules' "Web image does not reference non-existent workspace node_modules"
not_contains "$web_docker" 'COPY --from=dependencies /app/node_modules' "Web build does not depend on npm workspace node_modules layout"
fi
contains "$api_docker" 'COPY --from=build /app/packages/resourceportal-api/dist ./dist' "API image contains compiled runners"
not_contains "$api_docker" 'CMD ["ts-node"' "API runtime does not depend on ts-node"


not_contains "$api_docker" '/app/packages/resourceportal-api/node_modules' "API image does not reference non-existent workspace node_modules"

postgres_dockerfile="$repo_root/packages/resourceportal-postgres/Dockerfile"
[[ -f "$postgres_dockerfile" ]] && pass 'PostgreSQL fencing runtime Dockerfile exists' || fail 'PostgreSQL fencing runtime Dockerfile exists'
contains "$postgres_dockerfile" 'util-linux' 'PostgreSQL fencing image installs flock provider'
contains "$postgres_dockerfile" 'resourceportal-postgres-fence' 'PostgreSQL fencing image installs wrapper'

fence_script="$repo_root/packages/resourceportal-postgres/postgres-fence.sh"
not_contains "$fence_script" '.holder' 'PostgreSQL fencing does not leave stale holder marker files'
contains "$fence_script" 'flock -n 9' 'PostgreSQL fencing remains fail-closed on exclusive lock'

# Primary bootstrap must install the fencing helper from the same source that is
# packaged into the PostgreSQL image, and a copy failure must abort bootstrap.
lifecycle_file="$repo_root/scripts/installer/lifecycle.sh"
stack_template="$repo_root/config/production/stack.yml.tpl"
contains "$lifecycle_file" '"$RP_INSTALLER_REPO_ROOT/packages/resourceportal-postgres/postgres-fence.sh" "$etc/postgres-fence.sh" || return 1' 'Primary bootstrap installs the packaged PostgreSQL fencing helper and fails closed'
not_contains "$lifecycle_file" '$RP_INSTALLER_REPO_ROOT/config/production/postgres-fence.sh' 'Primary bootstrap does not reference missing fencing helper source'
contains "$stack_template" 'file: /etc/resourceportal/postgres-fence.sh' 'Swarm config reads PostgreSQL fencing helper from installer-managed path'
not_contains "$stack_template" 'file: /usr/local/share/resourceportal/postgres-fence.sh' 'Swarm config does not reference an unprovisioned host path'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All production packaging tests passed.\n'
