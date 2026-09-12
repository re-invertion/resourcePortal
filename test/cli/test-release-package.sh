#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/scripts/package-cli-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cli_dist="$tmp/cli-dist"
sdk_dist="$tmp/sdk-dist"
out_dir="$tmp/out"
prefix="$tmp/prefix"
mkdir -p "$cli_dist" "$sdk_dist" "$out_dir"

cat >"$cli_dist/index.js" <<'JS'
#!/usr/bin/env node
console.log('fixture help');
JS
chmod +x "$cli_dist/index.js"
printf "module.exports = { fixture: true };\n" >"$sdk_dist/full.js"
printf "export declare const fixture: boolean;\n" >"$sdk_dist/full.d.ts"

[[ -x "$script" ]] || { printf 'FAIL: release packaging script is missing or not executable\n' >&2; exit 1; }

"$script" 9.8.7 "$cli_dist" "$sdk_dist" "$out_dir"

archive="$out_dir/resource-portal-cli-9.8.7.tgz"
checksums="$out_dir/SHA256SUMS"
[[ -f "$archive" ]] || { printf 'FAIL: CLI release archive was not created\n' >&2; exit 1; }
[[ -f "$checksums" ]] || { printf 'FAIL: SHA256SUMS was not created\n' >&2; exit 1; }
(
  cd "$out_dir"
  sha256sum -c SHA256SUMS
)

tar -tzf "$archive" | grep -Fq 'package/dist/index.js'
tar -tzf "$archive" | grep -Fq 'package/node_modules/@resource-portal/sdk/dist/full.js'

npm install --global --prefix "$prefix" "$archive" >/dev/null
[[ "$("$prefix/bin/rp" --help)" == 'fixture help' ]]
[[ "$("$prefix/bin/resourceportal" --help)" == 'fixture help' ]]

installed_version="$(node -p "require('$prefix/lib/node_modules/@resource-portal/cli/package.json').version")"
[[ "$installed_version" == '9.8.7' ]] || { printf 'FAIL: expected package version 9.8.7, got %s\n' "$installed_version" >&2; exit 1; }

printf 'All CLI release package tests passed.\n'
