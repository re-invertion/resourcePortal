#!/usr/bin/env bash

rp_manifest_value() {
  local manifest="$1" expression="$2"
  jq -er "$expression" "$manifest"
}

rp_release_image_ref_valid() {
  [[ "$1" =~ ^[^[:space:]@]+@sha256:[a-fA-F0-9]{64}$ ]]
}

# A digest pins bytes, but cannot authorize an arbitrary publisher/repository.
# Image roles are restricted to projects managed by the release pipeline.
rp_release_image_repo_allowed() {
  local image="$1" role="$2" repository
  repository="${image%@sha256:*}"
  case "$role:$repository" in
    api:ghcr.io/re-invertion/resourceportal-api|\
    web:ghcr.io/re-invertion/resourceportal-web|\
    postgres:ghcr.io/re-invertion/resourceportal-postgres|\
    zitadel:ghcr.io/zitadel/zitadel|\
    traefik:traefik|\
    traefik:docker.io/library/traefik) return 0 ;;
  esac
  return 1
}

rp_validate_release_manifest() {
  local manifest="$1" image role
  [[ "$manifest" == /* && -r "$manifest" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  jq -e '
    .schemaVersion == 1 and
    (.version | type == "string") and
    (.installer.minimumVersion | type == "string") and
    (.docker.minimumVersion | type == "string") and
    (.configSchemaVersion | type == "number") and
    (.migrations.supportedFromVersions | type == "array" and length > 0) and
    (.migrations.rollbackPolicy == "none" or .migrations.rollbackPolicy == "image-only" or .migrations.rollbackPolicy == "tested") and
    ([.images.api,.images.web,.images.postgres,.images.zitadel,.images.traefik] | all(type == "string"))
  ' "$manifest" >/dev/null || return 1
  # Backward compatibility: source manifests released before DB restore proof
  # must remain readable for migration inspection. New automatic rollback is
  # independently blocked by rp_upgrade_rollback_allowed without both DB flags.
  # Assessment fields are optional for old release manifests, but when
  # present must be coherent. A "tested" claim needs explicit integration
  # evidence. The release builder never generates such a claim by inference.
  jq -e '
    (.migrations.rollbackAssessment == null or
      ((.migrations.rollbackAssessment.sourceVersion | type == "string") and
       (.migrations.rollbackAssessment.targetCommit | test("^[a-f0-9]{40}$")) and
       (.migrations.rollbackAssessment.reason |
         IN("no-resourceportal-database-schema-changes",
            "database-compatibility-not-verified",
            "milestone-requires-verified-recovery", "verified-recovery-test")))) and
    (if .migrations.rollbackPolicy == "tested" then
      (.migrations.rollbackAssessment.reason == "verified-recovery-test" and
       (.migrations.rollbackEvidence.kind == "real-upgrade-and-restore" and
        (.migrations.rollbackEvidence.workflowRunId | type == "number") and
        (.migrations.rollbackEvidence.sourceVersion | type == "string") and
        .migrations.rollbackEvidence.sourceVersion == .migrations.rollbackAssessment.sourceVersion and
        .migrations.rollbackEvidence.candidateZitadelImage == .images.zitadel and
        (.migrations.rollbackEvidence.candidateZitadelImage | type == "string")))
     else true end) and
    (if .migrations.rollbackAssessment != null and .migrations.rollbackPolicy == "image-only"
     then .migrations.rollbackAssessment.reason == "no-resourceportal-database-schema-changes"
     else true end)
  ' "$manifest" >/dev/null || return 1
  # Each rollback source is certified by the signed manifest for the exact
  # release SHA and the live Docker rollback job; upgrade compatibility alone
  # cannot authorize rollback.
  jq -e '
    . as $root |
    if ($root.migrations | has("rollbackCertifiedSources")) then
      ($root.migrations.rollbackCertifiedSources | type == "array" and length > 0) and
      (([$root.migrations.rollbackCertifiedSources[].sourceVersion] | unique | length) ==
       ($root.migrations.rollbackCertifiedSources | length)) and
      ([$root.migrations.rollbackCertifiedSources[] |
        (.sourceVersion | type == "string" and test("^[0-9]+[.][0-9]+[.][0-9]+$")) and
        (.sourceVersion as $src | $root.migrations.supportedFromVersions | index($src) != null) and
        (.targetCommit == $root.migrations.rollbackAssessment.targetCommit) and
        (.workflowRunId | type == "number" and . > 0) and
        (.kind == "real-upgrade-and-restore") and
        (.actualDatabaseMigration == true and
         .previousImagesRestored == true and .injectedHealthFailure == true and
         .databaseSnapshotVerified == true and .databaseSnapshotRestored == true and
         .restoredSourceSchema == true and .previousApiReadWriteAfterRollback == true and
         .previousApiRuntimeReadyAfterRollback == true and
         .zitadelDatabaseRestored == true and .zitadelSourceRuntimeReadyAfterRollback == true and
         .zitadelSourceEventstoreVerified == true and
         .candidateZitadelRuntimeReadyBeforeRollback == true) and
        (.candidateZitadelImage == $root.images.zitadel) and
        (.sourceZitadelImage | type == "string" and test("^ghcr[.]io/zitadel/zitadel@sha256:[a-f0-9]{64}$")) and
        (if .policy == "image-only" then .reason == "no-resourceportal-database-schema-changes"
         elif .policy == "tested" then .reason == "verified-recovery-test"
         else false end)
      ] | all)
    else true end
  ' "$manifest" >/dev/null || return 1
  for role in api web postgres zitadel traefik; do
    image="$(jq -er --arg role "$role" '.images[$role]' "$manifest")" || return 1
    rp_release_image_ref_valid "$image" || return 1
    rp_release_image_repo_allowed "$image" "$role" || return 1
  done
}

# The manifest is an executable upgrade instruction for a privileged Docker-socket
# updater. A digest and the repository URL alone cannot establish authorization.
# Sigstore/GitHub verifies the bytes, the release-workflow identity, and main ref.
# Unavailable verifier, missing attestation or invalid signature fail closed.
rp_verify_release_manifest_attestation() (
  local manifest="$1" version bundle tmp_dir url
  rp_validate_release_manifest "$manifest" || exit 1
  command -v gh >/dev/null 2>&1 || {
    printf 'Release provenance verification requires GitHub CLI.\n' >&2
    exit 1
  }
  version="$(jq -er '.version' "$manifest")" || exit 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1

  # The updater has no GH_TOKEN by design. The official release publishes the
  # signed Sigstore bundle as an immutable asset for API-free verification.
  bundle="${RP_RELEASE_ATTESTATION_BUNDLE:-}"
  if [[ -z "$bundle" ]]; then
    tmp_dir="$(mktemp -d /tmp/resourceportal-release-proof.XXXXXX)" || exit 1
    trap 'rm -rf -- "$tmp_dir"' EXIT
    bundle="$tmp_dir/resourceportal-release-manifest.bundle.json"
    url="https://github.com/re-invertion/resourcePortal/releases/download/v${version}/resourceportal-release-manifest.bundle.json"
    curl --fail --silent --show-error --location --proto '=https' "$url" -o "$bundle" || {
      printf 'Unable to fetch official release attestation bundle.\n' >&2
      exit 1
    }
  fi
  [[ -f "$bundle" && -s "$bundle" ]] || {
    printf 'Signed release attestation bundle is missing.\n' >&2
    exit 1
  }
  GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 gh attestation verify "$manifest" \
    --bundle "$bundle" \
    --repo re-invertion/resourcePortal \
    --signer-workflow re-invertion/resourcePortal/.github/workflows/release.yml \
    --source-ref refs/heads/main >/dev/null || {
      printf 'Release manifest has no valid official signed provenance.\n' >&2
      exit 1
    }
)

rp_release_install_compatible() {
  local manifest="$1" installer_version="$2" docker_version="$3" minimum_installer minimum_docker
  rp_validate_release_manifest "$manifest" || return 1
  minimum_installer="$(rp_manifest_value "$manifest" '.installer.minimumVersion')" || return 1
  minimum_docker="$(rp_manifest_value "$manifest" '.docker.minimumVersion')" || return 1
  rp_version_ge "$installer_version" "$minimum_installer" || return 1
  rp_version_ge "$docker_version" "$minimum_docker"
}

rp_release_compatible() {
  local manifest="$1" installer_version="$2" current_version="$3" docker_version="$4"
  rp_release_install_compatible "$manifest" "$installer_version" "$docker_version" || return 1
  jq -e --arg current "$current_version" '.migrations.supportedFromVersions | index("*") != null or index($current) != null' "$manifest" >/dev/null
}

rp_list_stable_releases() {
  local repo="${1:-re-invertion/resourcePortal}"
  curl --fail --silent --show-error --proto '=https' \
    "https://api.github.com/repos/${repo}/releases?per_page=50" \
    | jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name'
}

rp_detect_latest_stable_release() {
  local repo="${1:-re-invertion/resourcePortal}" tag
  tag="$(rp_list_stable_releases "$repo" | head -n 1)" || return 1
  [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || {
    printf 'No stable ResourcePortal release is available.\n' >&2
    return 1
  }
  printf '%s\n' "${BASH_REMATCH[1]}"
}

rp_download_release_manifest() {
  local version="$1" target="$2" repo="${3:-re-invertion/resourcePortal}" url
  [[ "$target" == /* ]] || return 1
  url="https://github.com/${repo}/releases/download/v${version}/resourceportal-release-manifest.json"
  curl --fail --silent --show-error --location --proto '=https' "$url" -o "$target" || return 1
  rp_validate_release_manifest "$target"
}

rp_persist_release_manifest() {
  local source="$1" state_dir target tmp
  rp_validate_release_manifest "$source" || return 1
  state_dir="${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}"
  target="${state_dir}/release.json"
  install -d -m 0700 "$state_dir" || return 1
  tmp="$(mktemp "${state_dir}/.release.json.XXXXXX")" || return 1
  if ! cp -- "$source" "$tmp" ||
     ! chmod 0644 "$tmp" ||
     ! rp_validate_release_manifest "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$target" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$target"
}

rp_apply_release_manifest_images() {
  local manifest="$1"
  rp_validate_release_manifest "$manifest" || return 1
  RP_CFG_API_IMAGE="$(rp_manifest_value "$manifest" '.images.api')"
  RP_CFG_WEB_IMAGE="$(rp_manifest_value "$manifest" '.images.web')"
  RP_CFG_POSTGRES_IMAGE="$(rp_manifest_value "$manifest" '.images.postgres')"
  RP_CFG_ZITADEL_IMAGE="$(rp_manifest_value "$manifest" '.images.zitadel')"
  RP_CFG_TRAEFIK_IMAGE="$(rp_manifest_value "$manifest" '.images.traefik')"
  RP_CFG_RELEASE_VERSION="$(rp_manifest_value "$manifest" '.version')"
  export RP_CFG_API_IMAGE RP_CFG_WEB_IMAGE RP_CFG_POSTGRES_IMAGE RP_CFG_ZITADEL_IMAGE RP_CFG_TRAEFIK_IMAGE RP_CFG_RELEASE_VERSION
}