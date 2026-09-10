#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"
source "$repo_root/scripts/installer/ui.sh"

failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }

phase_state="$(mktemp /tmp/rp-error-phase-state.XXXXXX)"
phase_events="$(mktemp /tmp/rp-error-phase-events.XXXXXX)"
phase_output="$(mktemp /tmp/rp-error-phase-output.XXXXXX)"
: >"$phase_state"; : >"$phase_events"
(
  export RP_UI_MODE=text
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$phase_events"; }
  failing_phase(){ printf '%s\n' 'ACME 429: too many certificates issued' >&2; return 17; }
  set +e
  rp_run_phase "$phase_state" ingress failing_phase >"$phase_output" 2>&1
  rc=$?
  set -e
  [[ $rc -eq 17 ]]
) && pass 'primary phase preserves failing command exit status' || fail 'primary phase preserves failing command exit status'
phase_text="$(cat "$phase_events")"
[[ "$phase_text" == *'phase_failed|ingress|'*'ACME 429: too many certificates issued'* ]] \
  && pass 'primary phase failure event includes concrete command error' \
  || fail 'primary phase failure event includes concrete command error'
[[ "$(cat "$phase_output")" == *'ACME 429: too many certificates issued'* ]] \
  && pass 'text mode prints concrete primary phase error' \
  || fail 'text mode prints concrete primary phase error'

mode_events="$(mktemp /tmp/rp-error-mode-events.XXXXXX)"
mode_output="$(mktemp /tmp/rp-error-mode-output.XXXXXX)"
: >"$mode_events"
(
  export RP_UI_MODE=text
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$mode_events"; }
  failing_mode(){ printf '%s\n' 'upgrade manifest incompatible' >&2; return 23; }
  set +e
  rp_ui_mode_operation upgrade apply 'Applying upgrade' failing_mode >"$mode_output" 2>&1
  rc=$?
  set -e
  [[ $rc -eq 23 ]]
) && pass 'shared mode wrapper preserves failing command exit status' || fail 'shared mode wrapper preserves failing command exit status'
mode_text="$(cat "$mode_events")"
[[ "$mode_text" == *'phase_failed|apply|'*'upgrade manifest incompatible'* ]] \
  && pass 'shared mode failure event includes concrete command error' \
  || fail 'shared mode failure event includes concrete command error'
[[ "$(cat "$mode_output")" == *'upgrade manifest incompatible'* ]] \
  && pass 'text mode prints concrete shared mode error' \
  || fail 'text mode prints concrete shared mode error'

reset_state="$(mktemp /tmp/rp-error-reset-state.XXXXXX)"
reset_events="$(mktemp /tmp/rp-error-reset-events.XXXXXX)"
reset_output="$(mktemp /tmp/rp-error-reset-output.XXXXXX)"
: >"$reset_state"; : >"$reset_events"
(
  export RP_UI_MODE=text
  export RP_FACTORY_RESET_STATE="$reset_state"
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$reset_events"; }
  failing_reset(){ printf '%s\n' 'storage fingerprint changed' >&2; return 29; }
  set +e
  rp_reset_run_phase wipe-storage failing_reset >"$reset_output" 2>&1
  rc=$?
  set -e
  [[ $rc -eq 29 ]]
) && pass 'factory reset phase preserves failing command exit status' || fail 'factory reset phase preserves failing command exit status'
reset_text="$(cat "$reset_events")"
[[ "$reset_text" == *'phase_failed|wipe-storage|'*'storage fingerprint changed'* ]] \
  && pass 'factory reset failure event includes concrete command error' \
  || fail 'factory reset failure event includes concrete command error'
[[ "$(cat "$reset_output")" == *'storage fingerprint changed'* ]] \
  && pass 'text mode prints concrete factory reset error' \
  || fail 'text mode prints concrete factory reset error'

silent_state="$(mktemp /tmp/rp-error-silent-state.XXXXXX)"
silent_events="$(mktemp /tmp/rp-error-silent-events.XXXXXX)"
: >"$silent_state"; : >"$silent_events"
(
  export RP_UI_MODE=text
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$silent_events"; }
  silent_failure(){ return 31; }
  set +e
  rp_run_phase "$silent_state" final silent_failure >/dev/null 2>&1
  rc=$?
  set -e
  [[ $rc -eq 31 ]]
) && pass 'silent phase preserves failure status' || fail 'silent phase preserves failure status'
silent_text="$(cat "$silent_events")"
[[ "$silent_text" == *'phase_failed|final|'*'silent_failure'*'exit 31'* ]] \
  && pass 'silent phase gets actionable fallback with exit status and command' \
  || fail 'silent phase gets actionable fallback with exit status and command'

tui_state="$(mktemp /tmp/rp-error-tui-state.XXXXXX)"
tui_events="$(mktemp /tmp/rp-error-tui-events.XXXXXX)"
tui_output="$(mktemp /tmp/rp-error-tui-output.XXXXXX)"
: >"$tui_state"; : >"$tui_events"
(
  export RP_UI_MODE=tui
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$tui_events"; }
  rp_ui_failure_action(){ printf 'exit\n'; }
  tui_failure(){ printf '%s\n' 'private raw diagnostic line' >&2; return 41; }
  set +e
  rp_run_phase "$tui_state" ingress tui_failure >"$tui_output" 2>&1
  rc=$?
  set -e
  [[ $rc -eq 41 ]]
) && pass 'TUI phase preserves failure status' || fail 'TUI phase preserves failure status'
[[ "$(cat "$tui_events")" == *'phase_failed|ingress|'*'private raw diagnostic line'* ]] \
  && pass 'TUI failure event receives concrete error' \
  || fail 'TUI failure event receives concrete error'
! grep -Fxq 'private raw diagnostic line' "$tui_output" \
  && pass 'TUI suppresses raw failing command stderr' \
  || fail 'TUI suppresses raw failing command stderr'

source "$repo_root/scripts/installer/domain.sh"
sleep(){ :; }
rp_validate_https_certificate(){ return 1; }
cert_error="$(rp_wait_for_https_certificate auth.resource-portal.pl 1 2>&1 || true)"
[[ "$cert_error" == *'HTTPS certificate readiness failed for auth.resource-portal.pl after 1s'* ]] \
  && pass 'certificate timeout reports domain and timeout' \
  || fail 'certificate timeout reports domain and timeout'
unset -f sleep rp_validate_https_certificate

rm -f "$phase_state" "$phase_events" "$phase_output" "$mode_events" "$mode_output" "$reset_state" "$reset_events" "$reset_output" "$silent_state" "$silent_events" "$tui_state" "$tui_events" "$tui_output"

if (( failures > 0 )); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All installer error reporting tests passed.\n'
