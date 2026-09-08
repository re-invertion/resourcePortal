#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
[[ -r "$repo_root/scripts/installer/dashboard.sh" ]] && source "$repo_root/scripts/installer/dashboard.sh"

failures=0
assert_eq(){ local e="$1" a="$2" n="$3"; if [[ "$e" == "$a" ]]; then printf 'PASS: %s\n' "$n"; else printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$n" "$e" "$a" >&2; failures=$((failures+1)); fi; }
assert_contains(){ local h="$1" n="$2" t="$3"; if [[ "$h" == *"$n"* ]]; then printf 'PASS: %s\n' "$t"; else printf 'FAIL: %s\nmissing: %s\n' "$t" "$n" >&2; failures=$((failures+1)); fi; }

state="$(mktemp)"
printf 'preflight\npackages\n' >"$state"
rp_primary_phase_names(){ printf '%s\n' preflight packages dns ingress; }
rp_dashboard_init primary "$state"
assert_eq 50 "$(rp_dashboard_progress_percent)" 'resume progress is checkpoint based'
assert_eq completed "$(rp_dashboard_phase_status preflight)" 'checkpoint marks completed'
assert_eq pending "$(rp_dashboard_phase_status dns)" 'uncheckpointed phase starts pending'

rp_dashboard_event phase_started dns 'Waiting for DNS'
assert_eq running "$(rp_dashboard_phase_status dns)" 'phase_started marks running'
rp_dashboard_event phase_blocked dns 'Waiting for records'
assert_eq blocked "$(rp_dashboard_phase_status dns)" 'blocked differs from failed'
rp_dashboard_event phase_unblocked dns 'DNS ready'
assert_eq running "$(rp_dashboard_phase_status dns)" 'unblocked returns to running'
rp_dashboard_event phase_failed dns 'DNS resolver failed'
assert_eq failed "$(rp_dashboard_phase_status dns)" 'phase_failed marks failed'

RP_DASHBOARD_ACTIVITY_MAX=5
for i in 1 2 3 4 5 6; do rp_dashboard_activity_add "activity-$i"; done
assert_eq 5 "${#RP_DASHBOARD_ACTIVITY[@]}" 'recent activity is bounded'
assert_eq activity-2 "${RP_DASHBOARD_ACTIVITY[0]}" 'oldest activity is dropped'

render="$(rp_dashboard_render_text)"
assert_contains "$render" 'Mode: Primary' 'semantic renderer includes mode'
assert_contains "$render" 'Progress: 50%' 'semantic renderer includes progress'
assert_contains "$render" '✓ preflight' 'semantic renderer shows completed phase'
assert_contains "$render" '✗ dns' 'semantic renderer shows failed phase'
assert_contains "$render" '○ ingress' 'semantic renderer shows pending phase'
assert_contains "$render" 'Current: DNS resolver failed' 'semantic renderer shows current operation'

rm -f "$state"
if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer dashboard tests passed.\n'
