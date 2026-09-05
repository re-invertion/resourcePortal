#!/usr/bin/env bash

rp_manifest_value() {
  local manifest="$1" expression="$2"
  jq -er "$expression" "$manifest"
}

rp_release_image_ref_valid() {
  [[ "$1" =~ ^[^[:space:]@]+@sha256:[a-fA-F0-9]{64}$ ]]
}

rp_validate_release_manifest() {
  local manifest="$1" image
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
  while IFS= read -r image; do
    rp_release_image_ref_valid "$image" || return 1
  done < <(jq -r '.images | [.api,.web,.postgres,.zitadel,.traefik][]' "$manifest")
}

rp_release_compatible() {
  local manifest="$1" installer_version="$2" current_version="$3" docker_version="$4" minimum_installer minimum_docker
  rp_validate_release_manifest "$manifest" || return 1
  minimum_installer="$(rp_manifest_value "$manifest" '.installer.minimumVersion')" || return 1
  minimum_docker="$(rp_manifest_value "$manifest" '.docker.minimumVersion')" || return 1
  rp_version_ge "$installer_version" "$minimum_installer" || return 1
  rp_version_ge "$docker_version" "$minimum_docker" || return 1
  jq -e --arg current "$current_version" '.migrations.supportedFromVersions | index("*") != null or index($current) != null' "$manifest" >/dev/null
}

rp_list_stable_releases() {
  local repo="${1:-re-invertion/resourcePortal}"
  curl --fail --silent --show-error --proto '=https' \
    "https://api.github.com/repos/${repo}/releases?per_page=50" \
    | jq -r '.[] | select(.draft == false and .prerelease == false) | .tag_name'
}

rp_download_release_manifest() {
  local version="$1" target="$2" repo="${3:-re-invertion/resourcePortal}" url
  [[ "$target" == /* ]] || return 1
  url="https://github.com/${repo}/releases/download/v${version}/resourceportal-release-manifest.json"
  curl --fail --silent --show-error --location --proto '=https' "$url" -o "$target" || return 1
  rp_validate_release_manifest "$target"
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
