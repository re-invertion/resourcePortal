#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0

pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
assert_eq(){ local expected="$1" actual="$2" name="$3"; [[ "$expected" == "$actual" ]] && pass "$name" || { printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2; failures=$((failures+1)); }; }
assert_contains(){ local haystack="$1" needle="$2" name="$3"; [[ "$haystack" == *"$needle"* ]] && pass "$name" || { printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2; failures=$((failures+1)); }; }
assert_not_contains(){ local haystack="$1" needle="$2" name="$3"; [[ "$haystack" != *"$needle"* ]] && pass "$name" || { printf 'FAIL: %s\nunexpected: %q\n' "$name" "$needle" >&2; failures=$((failures+1)); }; }

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# 1. Real pseudo-TTY selects TUI when a verified pinned gum is already available.
fake_gum="$tmpdir/gum"
cat >"$fake_gum" <<'GUM'
#!/usr/bin/env bash
if [[ "${1:-}" == '--version' ]]; then
  printf 'gum version 0.17.0\n'
  exit 0
fi
exit 0
GUM
chmod +x "$fake_gum"
pty_helper="$tmpdir/pty-helper.sh"
cat >"$pty_helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
RP_GUM_BIN="$fake_gum"
RP_NON_INTERACTIVE=false
export RP_GUM_BIN RP_NON_INTERACTIVE
rp_ui_init
printf 'mode=%s\n' "\$RP_UI_MODE"
EOF
chmod +x "$pty_helper"
pty_output="$(script -qec "$pty_helper" /dev/null 2>&1 | tr -d '\r')"
assert_contains "$pty_output" 'mode=tui' 'pseudo-TTY selects TUI with verified gum'

# 2. Non-TTY uses deterministic text mode and emits no cursor-control bytes.
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
non_tty_mode="$(rp_ui_mode_select false)"
assert_eq text "$non_tty_mode" 'non-TTY selects text mode'
RP_UI_MODE=text
text_output="$(rp_ui_event activity installer 'text-mode-event' 2>&1)"
assert_contains "$text_output" 'text-mode-event' 'text mode emits line-oriented event'
assert_not_contains "$text_output" $'\033[' 'text mode emits no cursor-control sequence'

# 3. --non-interactive semantics force text mode even when TTY detection is true.
rp_ui_has_tty(){ return 0; }
assert_eq text "$(rp_ui_mode_select true)" 'non-interactive forces text mode under TTY'

# 4. Normal gum bootstrap failure falls back to text and leaves promotion pending.
(
  rp_ui_has_tty(){ return 0; }
  rp_ui_ensure_gum(){ return 20; }
  rp_log(){ :; }
  RP_NON_INTERACTIVE=false
  RP_UI_MODE=text
  RP_UI_TUI_PENDING=false
  rp_ui_init
  printf '%s|%s\n' "$RP_UI_MODE" "$RP_UI_TUI_PENDING"
) >"$tmpdir/fallback"
assert_eq 'text|true' "$(cat "$tmpdir/fallback")" 'normal gum failure falls back to text with pending promotion'

# 5. Integrity failure is hard failure, not fallback.
set +e
(
  rp_ui_has_tty(){ return 0; }
  rp_ui_ensure_gum(){ return 21; }
  rp_log(){ :; }
  RP_NON_INTERACTIVE=false
  rp_ui_init
) >/dev/null 2>&1
integrity_rc=$?
set -e
assert_eq 1 "$integrity_rc" 'gum checksum mismatch stops TUI initialization'

# 6. Resume reconstructs progress from an existing Primary checkpoint state.
source "$repo_root/scripts/installer/dashboard.sh"
resume_state="$tmpdir/primary.state"
printf 'preflight\npackages\n' >"$resume_state"
rp_primary_phase_names(){ printf '%s\n' preflight packages dns ingress; }
rp_dashboard_init primary "$resume_state"
assert_eq 50 "$(rp_dashboard_progress_percent)" 'partial Primary state reconstructs progress'
assert_eq completed "$(rp_dashboard_phase_status packages)" 'resume reconstructs completed stage'
assert_eq pending "$(rp_dashboard_phase_status dns)" 'resume leaves unfinished stage pending'

# 7. DNS gate visibly transitions blocked -> unblocked when propagation becomes correct.
source "$repo_root/scripts/installer/domain.sh"
dns_calls="$tmpdir/dns-calls"; printf '0\n' >"$dns_calls"
dns_events="$tmpdir/dns-events"; : >"$dns_events"
rp_resolve_domain_addresses(){
  local n domain="$1"
  n="$(cat "$dns_calls")"; n=$((n+1)); printf '%s\n' "$n" >"$dns_calls"
  case "$n" in
    1) return 0 ;;
    2) printf '203.0.113.10\n' ;;
    *) printf '109.206.199.72\n' ;;
  esac
}
rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$dns_events"; }
sleep(){ :; }
rp_wait_for_required_dns resource-portal.pl auth.resource-portal.pl 109.206.199.72 1 >/dev/null
unset -f sleep rp_resolve_domain_addresses rp_ui_event
dns_event_text="$(cat "$dns_events")"
assert_contains "$dns_event_text" 'phase_blocked|dns|Waiting for required DNS A records' 'DNS gate emits blocked state'
assert_contains "$dns_event_text" 'phase_unblocked|dns|Required DNS records are ready' 'DNS gate emits unblocked state after propagation'

# 8. A failed TUI phase can retry and succeeds with one checkpoint.
source "$repo_root/scripts/installer/lifecycle.sh"
retry_state="$tmpdir/retry.state"; : >"$retry_state"
retry_count="$tmpdir/retry-count"; printf '0\n' >"$retry_count"
retry_phase(){
  local n
  n="$(cat "$retry_count")"; n=$((n+1)); printf '%s\n' "$n" >"$retry_count"
  (( n >= 2 ))
}
rp_ui_event(){ :; }
rp_ui_failure_action(){ printf 'retry\n'; }
RP_UI_MODE=tui
rp_run_phase "$retry_state" dns retry_phase
assert_eq 2 "$(cat "$retry_count")" 'failed TUI phase retries exactly once before success'
assert_eq 1 "$(grep -c '^dns$' "$retry_state")" 'retry success creates one checkpoint'
unset -f retry_phase rp_ui_event rp_ui_failure_action


# 9. Factory-reset phase retry uses the separate reset journal exactly once.
source "$repo_root/scripts/installer/reset.sh"
reset_retry_state="$tmpdir/factory-retry.state"; : >"$reset_retry_state"
RP_FACTORY_RESET_STATE="$reset_retry_state"; export RP_FACTORY_RESET_STATE
reset_retry_count="$tmpdir/factory-retry-count"; printf '0\n' >"$reset_retry_count"
reset_retry_phase(){
  local n
  n="$(cat "$reset_retry_count")"; n=$((n+1)); printf '%s\n' "$n" >"$reset_retry_count"
  (( n >= 2 ))
}
rp_ui_event(){ :; }
rp_ui_failure_action(){ printf 'retry\n'; }
RP_UI_MODE=tui
set +e
rp_reset_run_phase wipe-storage reset_retry_phase
reset_retry_rc=$?
set -e
assert_eq 0 "$reset_retry_rc" 'factory reset failed phase can retry'
assert_eq 2 "$(cat "$reset_retry_count")" 'factory reset retry reruns failed command once'
assert_eq 1 "$(grep -c '^wipe-storage$' "$reset_retry_state")" 'factory reset retry creates one checkpoint'
unset -f reset_retry_phase rp_ui_event rp_ui_failure_action

# 10. Interactive gum prompts stay visible even while a TUI phase captures stderr.
prompt_gum="$tmpdir/prompt-gum"
cat >"$prompt_gum" <<'GUM'
#!/usr/bin/env bash
case "${1:-}" in
  input)
    printf 'VISIBLE_DESTRUCTIVE_PROMPT\n' >&2
    IFS= read -r answer
    printf '%s\n' "$answer"
    ;;
  *) exit 2 ;;
esac
GUM
chmod +x "$prompt_gum"
prompt_helper="$tmpdir/prompt-helper.sh"
cat >"$prompt_helper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
RP_UI_MODE=tui
RP_GUM_BIN="$prompt_gum"
RP_DASHBOARD_ENTERED=false
export RP_UI_MODE RP_GUM_BIN RP_DASHBOARD_ENTERED
prompt_phase(){
  local value
  value="\$(rp_ui_input 'Destructive storage confirmation' 'Type exactly: FORMAT /dev/sda' '')"
  printf 'VALUE=%s\\n' "\$value"
}
rp_run_capture_error prompt_phase
EOF
chmod +x "$prompt_helper"
prompt_output="$(printf 'FORMAT /dev/sda\n' | script -qec "$prompt_helper" /dev/null 2>&1 | tr -d '\r')"
assert_contains "$prompt_output" 'VISIBLE_DESTRUCTIVE_PROMPT' 'TUI phase capture keeps interactive gum prompt visible'
assert_contains "$prompt_output" 'VALUE=FORMAT /dev/sda' 'TUI phase capture still returns interactive gum value'

if (( failures > 0 )); then
  printf '%s test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'All installer TUI integration tests passed.\n'
