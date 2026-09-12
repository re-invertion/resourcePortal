#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s VERSION CLI_DIST SDK_DIST OUTPUT_DIR\n' "${0##*/}" >&2
}

[[ $# -eq 4 ]] || { usage; exit 2; }
version="$1"
cli_dist="$2"
sdk_dist="$3"
out_dir="$4"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid semantic version: %s\n' "$version" >&2; exit 2; }
[[ -d "$cli_dist" && -f "$cli_dist/index.js" ]] || { printf 'CLI dist is missing index.js: %s\n' "$cli_dist" >&2; exit 1; }
[[ -d "$sdk_dist" && -f "$sdk_dist/full.js" ]] || { printf 'SDK dist is missing full.js: %s\n' "$sdk_dist" >&2; exit 1; }

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd -P)"
cli_dist="$(cd "$cli_dist" && pwd -P)"
sdk_dist="$(cd "$sdk_dist" && pwd -P)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/dist" "$stage/node_modules/@resource-portal/sdk/dist"
cp -a "$cli_dist/." "$stage/dist/"
cp -a "$sdk_dist/." "$stage/node_modules/@resource-portal/sdk/dist/"

cat >"$stage/package.json" <<EOF_PACKAGE
{
  "name": "@resource-portal/cli",
  "version": "$version",
  "description": "Resource Portal command line interface",
  "bin": {
    "resourceportal": "dist/index.js",
    "rp": "dist/index.js"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "@resource-portal/sdk": "0.1.0"
  },
  "bundledDependencies": [
    "@resource-portal/sdk"
  ]
}
EOF_PACKAGE

cat >"$stage/node_modules/@resource-portal/sdk/package.json" <<'EOF_SDK'
{
  "name": "@resource-portal/sdk",
  "version": "0.1.0",
  "type": "commonjs",
  "main": "dist/full.js",
  "types": "dist/full.d.ts",
  "exports": {
    ".": {
      "types": "./dist/full.d.ts",
      "default": "./dist/full.js"
    }
  }
}
EOF_SDK

packed_name="$(cd "$stage" && npm pack --silent --pack-destination "$out_dir")"
archive="$out_dir/resource-portal-cli-$version.tgz"
if [[ "$out_dir/$packed_name" != "$archive" ]]; then
  mv -f "$out_dir/$packed_name" "$archive"
fi
(
  cd "$out_dir"
  sha256sum "$(basename "$archive")" > SHA256SUMS
)
printf '%s\n' "$archive"
