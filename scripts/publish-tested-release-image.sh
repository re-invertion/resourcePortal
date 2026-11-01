#!/usr/bin/env bash
# Release-only: publish the exact local image that the rollback smoke tested.
# A second image build (including Buildx) after rollback validation is forbidden.
set -euo pipefail

fail() { echo "Release image publication blocked: $*" >&2; exit 1; }

role="${1:-}" tag="${2:-}"
case "$role" in api|web|postgres) ;; *) fail "Unsupported release role" ;; esac
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid release tag"
[[ "${GITHUB_REPOSITORY_OWNER:-}" =~ ^[A-Za-z0-9_-]+$ && -n "${GITHUB_OUTPUT:-}" ]] ||
  fail "Missing GitHub publication context"

repo="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/resourceportal-$role"
candidate="resourceportal-$role-candidate"
published="$repo:$tag"

# The candidate already passed the real Swarm rollback gate on this runner.
tested_id="$(docker image inspect --format '{{.Id}}' "$candidate")" ||
  fail "Rollback-tested $role candidate image is missing"
[[ "$tested_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
  fail "Rollback-tested $role candidate has an invalid image ID"

# A tag can already exist after a partially failed release. Do NOT overwrite
# it or assume the first locally recorded RepoDigest is the registry digest.
# The remote manifest's config digest is the Docker image ID for the
# single-platform images created by this release workflow.
verify_remote() {
  local inspection="$1" digest raw config
  digest="$(printf '%s\n' "$inspection" | awk '$1 == "Digest:" {print $2; exit}')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Registry did not return a valid digest for $published"
  raw="$(docker buildx imagetools inspect --raw "$repo@$digest")" ||
    fail "Unable to retrieve published $role manifest by immutable digest"
  config="$(jq -er '.config.digest | select(type == "string")' <<<"$raw")" ||
    fail "Published $role image has no single-platform config digest"
  [[ "$config" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    fail "Published $role image has an invalid config digest"
  [[ "$config" == "$tested_id" ]] ||
    fail "Registry $role manifest config $config differs from rollback-tested image $tested_id"
  printf '%s\n' "$digest"
}

if inspection="$(docker buildx imagetools inspect "$published" 2>&1)"; then
  # The same version may have been partially published. Reuse it ONLY if its
  # immutable manifest points to the exact candidate that passed rollback.
  digest="$(verify_remote "$inspection")"
  echo "PASS: existing $published contains rollback-tested image ($repo@$digest)"
else
  # Never interpret a network/auth/registry error as permission to overwrite.
  if ! grep -Eqi '(: not found|manifest unknown|MANIFEST_UNKNOWN|404 Not Found)' <<<"$inspection"; then
    fail "Cannot determine whether $published exists: $inspection"
  fi
  docker tag "$candidate" "$published"
  [[ "$(docker image inspect --format '{{.Id}}' "$published")" == "$tested_id" ]] ||
    fail "Release tag would publish a different binary than rollback-tested $role"
  docker push "$published" ||
    fail "Push failed for rollback-tested $role image"
  inspection="$(docker buildx imagetools inspect "$published")" ||
    fail "Cannot inspect published $role tag after push"
  digest="$(verify_remote "$inspection")"
  echo "PASS: published exactly rollback-tested $role image ($repo@$digest)"
fi

printf 'digest=%s\n' "$digest" >> "$GITHUB_OUTPUT"
