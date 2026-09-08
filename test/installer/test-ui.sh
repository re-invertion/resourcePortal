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

entrypoint_source="$(cat "$repo_root/resourceportal-install.sh")"
assert_contains "$entrypoint_source" '--non-interactive' 'entrypoint parses non-interactive flag'
assert_contains "$entrypoint_source" 'RP_NON_INTERACTIVE=true' 'entrypoint exports non-interactive mode'

if (( failures > 0 )); then
  printf '%s\n' "$failures test(s) failed" >&2
  exit 1
fi
printf 'All installer UI tests passed.\n'
