#!/usr/bin/env bash
# Release-only: publish the exact local image that the rollback smoke tested.
# A second image build (including Buildx) after rollback validation is forbidden.
set -euo pipefail

role="${1:-}" tag="${2:-}"
case "$role" in api|web|postgres) ;; *) echo "Unsupported release role" >&2; exit 1 ;; esac
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid release tag" >&2; exit 1; }
[[ "${GITHUB_REPOSITORY_OWNER:-}" =~ ^[A-Za-z0-9_-]+$ && -n "${GITHUB_OUTPUT:-}" ]] || {
  echo "Missing GitHub publication context" >&2; exit 1;
}
repo="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/resourceportal-$role"
candidate="resourceportal-$role-candidate"
published="$repo:$tag"

# Preflight must have already built/tested these exact local image IDs.
tested_id="$(docker image inspect --format '{{.Id}}' "$candidate")" || exit 1
[[ "$tested_id" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
docker tag "$candidate" "$published"
[[ "$(docker image inspect --format '{{.Id}}' "$published")" == "$tested_id" ]] || {
  echo "Release would publish a different binary than the rollback-tested $role" >&2; exit 1;
}
docker push "$published"
ref="$(docker image inspect --format '{{index .RepoDigests 0}}' "$published")" || exit 1
[[ "$ref" == "$repo@sha256:"* && "$ref" =~ @sha256:[a-f0-9]{64}$ ]] || exit 1
# Confirm registry digest is attached to the exact local tested binary.
[[ "$(docker image inspect --format '{{.Id}}' "$ref")" == "$tested_id" ]] || {
  echo "Registry digest differs from rollback-tested $role image ID" >&2; exit 1;
}
echo "digest=${ref##*@}" >> "$GITHUB_OUTPUT"
echo "PASS: published exactly rollback-tested $role image ($ref)"
