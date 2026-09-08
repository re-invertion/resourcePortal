#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"

failures=0
assert_eq(){ local e="$1" a="$2" n="$3"; if [[ "$e" == "$a" ]]; then printf 'PASS: %s\n' "$n"; else printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$n" "$e" "$a" >&2; failures=$((failures+1)); fi; }
assert_contains(){ local h="$1" n="$2" t="$3"; if [[ "$h" == *"$n"* ]]; then printf 'PASS: %s\n' "$t"; else printf 'FAIL: %s\nmissing: %s\n' "$t" "$n" >&2; failures=$((failures+1)); fi; }

rp_ui_has_tty(){ return 0; }
assert_eq tui "$(rp_ui_mode_select false)" 'interactive TTY selects TUI'
assert_eq text "$(rp_ui_mode_select true)" 'non-interactive forces text mode'
rp_ui_has_tty(){ return 1; }
assert_eq text "$(rp_ui_mode_select false)" 'non-TTY selects text mode'

RP_UI_MODE=text
text_event="$(rp_ui_event phase_started migrations 'Applying database migrations' 2>&1)"
assert_contains "$text_event" '[migrations]' 'text event includes scope'
assert_contains "$text_event" 'Applying database migrations' 'text event includes message'

assert_eq 'gum_0.17.0_Linux_x86_64.tar.gz' "$(rp_ui_gum_asset amd64)" 'amd64 gum asset'
assert_eq 'gum_0.17.0_Linux_arm64.tar.gz' "$(rp_ui_gum_asset arm64)" 'arm64 gum asset'
assert_eq '69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb' "$(rp_ui_gum_expected_sha256 amd64)" 'amd64 gum checksum'
assert_eq 'b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c' "$(rp_ui_gum_expected_sha256 arm64)" 'arm64 gum checksum'

bootstrap_tmp="$(mktemp -d)"
archive_root="$bootstrap_tmp/archive/gum_0.17.0_Linux_x86_64"
mkdir -p "$archive_root"
cat >"$archive_root/gum" <<'GUM'
#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then printf 'gum version 0.17.0\n'; fi
GUM
chmod +x "$archive_root/gum"
tar -czf "$bootstrap_tmp/gum.tar.gz" -C "$bootstrap_tmp/archive" gum_0.17.0_Linux_x86_64
fake_sha="$(sha256sum "$bootstrap_tmp/gum.tar.gz" | awk '{print $1}')"

(
  RP_GUM_INSTALL_DIR="$bootstrap_tmp/install-ok"
  rp_ui_arch(){ printf 'amd64\n'; }
  rp_ui_gum_expected_sha256(){ printf '%s\n' "$fake_sha"; }
  curl(){ local out=''; while (($#)); do [[ "$1" == '-o' ]] && { out="$2"; shift 2; continue; }; shift; done; cp "$bootstrap_tmp/gum.tar.gz" "$out"; }
  export -f curl
  rp_ui_ensure_gum
  [[ -x "$RP_GUM_BIN" ]] || exit 1
  [[ "$($RP_GUM_BIN --version)" == *'0.17.0'* ]] || exit 1
) && printf 'PASS: verified gum artifact installs usable binary\n' || { printf 'FAIL: verified gum artifact installs usable binary\n' >&2; failures=$((failures+1)); }

set +e
(
  RP_GUM_INSTALL_DIR="$bootstrap_tmp/install-bad"
  rp_ui_arch(){ printf 'amd64\n'; }
  rp_ui_gum_expected_sha256(){ printf '%064d\n' 0; }
  curl(){ local out=''; while (($#)); do [[ "$1" == '-o' ]] && { out="$2"; shift 2; continue; }; shift; done; cp "$bootstrap_tmp/gum.tar.gz" "$out"; }
  export -f curl
  rp_ui_ensure_gum
)
checksum_rc=$?
(
  RP_GUM_INSTALL_DIR="$bootstrap_tmp/install-download"
  rp_ui_arch(){ printf 'amd64\n'; }
  curl(){ return 22; }
  export -f curl
  rp_ui_ensure_gum
)
download_rc=$?
set -e
assert_eq 21 "$checksum_rc" 'checksum mismatch is security failure'
assert_eq 20 "$download_rc" 'download failure selects fallback status'
rm -rf "$bootstrap_tmp"

prompt_tmp="$(mktemp -d)"
fake_prompt_gum="$prompt_tmp/gum"
cat >"$fake_prompt_gum" <<'GUM'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_GUM_LOG"
case "${1:-}" in
  input)
    shift
    if [[ " $* " == *' --password '* ]]; then printf '%s\n' "${FAKE_GUM_PASSWORD:-}"; else printf '%s\n' "${FAKE_GUM_INPUT:-}"; fi
    ;;
  choose) printf '%s\n' "${FAKE_GUM_CHOICE:-}" ;;
  confirm) [[ "${FAKE_GUM_CONFIRM:-yes}" == yes ]] ;;
  style) shift; last=''; for arg in "$@"; do last="$arg"; done; printf '%s\n' "$last" ;;
esac
GUM
chmod +x "$fake_prompt_gum"
export RP_UI_MODE=tui RP_GUM_BIN="$fake_prompt_gum" FAKE_GUM_LOG="$prompt_tmp/gum.log"
export FAKE_GUM_INPUT='typed-value' FAKE_GUM_PASSWORD='HiddenPass1!' FAKE_GUM_CHOICE='ext4' FAKE_GUM_CONFIRM=yes
assert_eq 'typed-value' "$(rp_ui_input 'Storage' 'Path' '/srv/default')" 'gum input returns entered value'
assert_eq 'HiddenPass1!' "$(rp_ui_password 'Admin' 'Password')" 'gum password returns hidden value'
assert_eq 'ext4' "$(rp_ui_choice 'Filesystem' 'Choose filesystem' xfs xfs 'XFS recommended' ext4 'EXT4')" 'gum choice returns machine value'
set +e
rp_ui_confirm 'Confirm' 'Proceed?' >/tmp/rp-ui-confirm.out 2>/tmp/rp-ui-confirm.err
confirm_yes_rc=$?
FAKE_GUM_CONFIRM=no rp_ui_confirm 'Confirm' 'Proceed?' >/tmp/rp-ui-confirm.out 2>/tmp/rp-ui-confirm.err
confirm_no_rc=$?
set -e
assert_eq 0 "$confirm_yes_rc" 'gum confirm accepts yes'
assert_eq 1 "$confirm_no_rc" 'gum confirm rejects no'
prompt_log="$(cat "$prompt_tmp/gum.log")"
assert_contains "$prompt_log" 'input --header Storage' 'gum input receives title'
assert_contains "$prompt_log" '--value /srv/default' 'gum input receives default'
assert_contains "$prompt_log" '--password' 'gum password uses masked input'
assert_contains "$prompt_log" '--label-delimiter :::' 'gum choice uses stable label mapping'
if [[ "$prompt_log" == *'HiddenPass1!'* ]]; then printf 'FAIL: gum password leaks value into command arguments\n' >&2; failures=$((failures+1)); else printf 'PASS: gum password does not leak value into command arguments\n'; fi
rm -rf "$prompt_tmp"
unset FAKE_GUM_INPUT FAKE_GUM_PASSWORD FAKE_GUM_CHOICE FAKE_GUM_CONFIRM FAKE_GUM_LOG
RP_UI_MODE=text

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
assert_contains "$entrypoint_source" '--non-interactive' 'entrypoint parses non-interactive flag'
assert_contains "$entrypoint_source" 'RP_NON_INTERACTIVE=true' 'entrypoint exports non-interactive mode'

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer UI tests passed.\n'
