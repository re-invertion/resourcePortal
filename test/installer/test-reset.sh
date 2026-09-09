#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/config.sh"
source "$repo_root/scripts/installer/ownership.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"

failures=0
assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_status() {
  local expected="$1" name="$2"; shift 2
  set +e
  "$@" >/tmp/rp-installer-reset.out 2>/tmp/rp-installer-reset.err
  local actual=$?
  set -e
  assert_eq "$expected" "$actual" "$name"
}
assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_file_exists() {
  local path="$1" name="$2"
  [[ -e "$path" ]] && printf 'PASS: %s\n' "$name" || { printf 'FAIL: %s\nmissing file: %s\n' "$name" "$path" >&2; failures=$((failures + 1)); }
}
assert_file_missing() {
  local path="$1" name="$2"
  [[ ! -e "$path" ]] && printf 'PASS: %s\n' "$name" || { printf 'FAIL: %s\nunexpected file: %s\n' "$name" "$path" >&2; failures=$((failures + 1)); }
}

assert_status 0 'reset mode valid' rp_mode_valid reset
assert_status 0 'settings scope valid' rp_reset_scope_valid settings
assert_status 0 'installer-state scope valid' rp_reset_scope_valid installer-state
assert_status 0 'factory scope valid' rp_reset_scope_valid factory
assert_status 1 'unknown reset scope rejected' rp_reset_scope_valid wipe

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
assert_contains "$entrypoint_source" '--scope' 'help/parser supports reset scope'
assert_contains "$entrypoint_source" '--confirm-factory-reset' 'parser supports factory confirmation flag'
assert_contains "$entrypoint_source" '--force-remove-untracked-packages' 'parser supports legacy package override'
assert_contains "$entrypoint_source" 'Reset / Clear ResourcePortal' 'interactive mode chooser exposes reset'

source "$repo_root/resourceportal-install.sh"

main_noninteractive_without_scope() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_main --config /definitely/missing.conf --mode reset --non-interactive
)
assert_status 2 'non-interactive reset requires explicit scope' main_noninteractive_without_scope

main_settings_rejects_factory_flag() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_main --config /definitely/missing.conf --mode reset --scope settings --confirm-factory-reset
)
assert_status 2 'settings rejects factory-only confirmation flag' main_settings_rejects_factory_flag

main_interactive_scope_choice() (
  unset RP_CFG_MODE RP_NON_INTERACTIVE RP_CONFIRM_FACTORY_RESET RP_FORCE_REMOVE_UNTRACKED_PACKAGES
  rp_require_root() { :; }
  rp_log_init() { :; }
  rp_ui_init() { RP_UI_MODE=text; export RP_UI_MODE; }
  rp_ui_cleanup() { :; }
  rp_ui_choice() { printf 'settings\n'; }
  rp_reset() { printf 'RESET:%s\n' "$1"; }
  rp_main --config /definitely/missing.conf --mode reset
)
interactive_out="$(main_interactive_scope_choice 2>/tmp/rp-reset-interactive.err || true)"
assert_contains "$interactive_out" 'RESET:settings' 'interactive reset prompts and dispatches selected scope'

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
RP_INSTALLER_STATE_DIR="$tmpdir/state"
RP_PRIMARY_STATE_FILE="$RP_INSTALLER_STATE_DIR/primary.state"
RP_INSTALLER_CONFIG_FILE="$tmpdir/installer.conf"
RP_CFG_STORAGE_BASE_PATH="$tmpdir/storage"
RP_OWNERSHIP_MANIFEST="$RP_INSTALLER_STATE_DIR/owned-resources"
export RP_INSTALLER_STATE_DIR RP_PRIMARY_STATE_FILE RP_INSTALLER_CONFIG_FILE RP_CFG_STORAGE_BASE_PATH RP_OWNERSHIP_MANIFEST
mkdir -p "$RP_INSTALLER_STATE_DIR" "$RP_CFG_STORAGE_BASE_PATH"

printf 'RP_CFG_MODE=primary\n' >"$RP_INSTALLER_CONFIG_FILE"
rp_reset_active_control_plane() { return 1; }
rp_reset_settings
assert_file_missing "$RP_INSTALLER_CONFIG_FILE" 'safe incomplete settings reset removes config'

printf 'RP_CFG_MODE=primary\n' >"$RP_INSTALLER_CONFIG_FILE"
printf 'final\n' >"$RP_PRIMARY_STATE_FILE"
assert_status 1 'final checkpoint refuses settings reset' rp_reset_settings
assert_file_exists "$RP_INSTALLER_CONFIG_FILE" 'final checkpoint preserves config'

printf 'preflight\n' >"$RP_PRIMARY_STATE_FILE"
rp_reset_active_control_plane() { return 0; }
assert_status 1 'active control plane refuses settings reset' rp_reset_settings
assert_file_exists "$RP_INSTALLER_CONFIG_FILE" 'active control plane preserves config'

rp_reset_active_control_plane() { return 1; }
mkdir -p "$RP_INSTALLER_STATE_DIR/secrets" "$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres"
printf 'secret-state\n' >"$RP_INSTALLER_STATE_DIR/secrets/encryption"
printf 'db-state\n' >"$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres/PG_VERSION"
printf 'preflight\n' >"$RP_PRIMARY_STATE_FILE"
printf 'package nfs-ganesha\n' >"$RP_OWNERSHIP_MANIFEST"
mountpoint() { [[ "$2" == /mnt/resourceportal/platform ]]; }
assert_status 1 'protected runtime refuses installer-state reset' rp_reset_installer_state
assert_file_exists "$RP_PRIMARY_STATE_FILE" 'protected reset preserves primary checkpoint'
assert_file_exists "$RP_OWNERSHIP_MANIFEST" 'protected reset preserves ownership manifest'
unset -f mountpoint

rm -rf "$RP_INSTALLER_STATE_DIR/secrets" "$RP_CFG_STORAGE_BASE_PATH/platform/databases/resourceportal-postgres"
printf 'preflight\npackages\n' >"$RP_PRIMARY_STATE_FILE"
printf '{}\n' >"$RP_INSTALLER_STATE_DIR/release.json"
mkdir -p "$RP_INSTALLER_STATE_DIR/enrollment" "$RP_INSTALLER_STATE_DIR/identity-bootstrap"
printf 'keep\n' >"$RP_OWNERSHIP_MANIFEST"
rp_reset_runtime_mount_present() { return 1; }
rp_reset_managed_swarm_secret_present() { return 1; }
rp_reset_installer_state
assert_file_missing "$RP_PRIMARY_STATE_FILE" 'safe installer-state reset removes primary checkpoint'
assert_file_missing "$RP_INSTALLER_STATE_DIR/release.json" 'safe installer-state reset removes release replay state'
assert_file_exists "$RP_OWNERSHIP_MANIFEST" 'safe installer-state reset preserves provenance manifest'

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer reset interface/safe-scope tests passed.\n'
