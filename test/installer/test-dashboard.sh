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

fake_gum_dir="$(mktemp -d)"
fake_gum="$fake_gum_dir/gum"
cat >"$fake_gum" <<'GUM'
#!/usr/bin/env bash
cmd="${1:-}"; shift || true
case "$cmd" in
  style)
    last=''
    for arg in "$@"; do last="$arg"; done
    printf '%s\n' "$last"
    ;;
  join)
    for arg in "$@"; do
      case "$arg" in --horizontal|--vertical|--align=*|--*) continue ;; esac
      printf '%s\n' "$arg"
    done
    ;;
  *) printf '%s\n' "$*" ;;
esac
GUM
chmod +x "$fake_gum"
RP_GUM_BIN="$fake_gum"
RP_UI_MODE=tui
RP_DASHBOARD_STATUS[dns]=running
RP_DASHBOARD_OPERATION='Checking DNS records'
rp_dashboard_activity_add 'Waiting for DNS'
full_render="$(rp_dashboard_render 2>&1)"
assert_contains "$full_render" 'ResourcePortal Production Installer' 'full renderer includes title'
assert_contains "$full_render" 'Mode: Primary' 'full renderer includes mode'
assert_contains "$full_render" 'Progress: 50%' 'full renderer includes progress'
assert_contains "$full_render" '● dns' 'full renderer includes running phase'
assert_contains "$full_render" 'Checking DNS records' 'full renderer includes current operation'
assert_contains "$full_render" 'Waiting for DNS' 'full renderer includes recent activity'

terminal_log="$fake_gum_dir/terminal-actions"
rp_dashboard_terminal_action(){ printf '%s\n' "$1" >>"$terminal_log"; }
rp_dashboard_enter
rp_dashboard_leave
rp_dashboard_leave
terminal_actions="$(cat "$terminal_log")"
assert_contains "$terminal_actions" 'hide_cursor' 'dashboard enter hides cursor'
assert_contains "$terminal_actions" 'show_cursor' 'dashboard leave restores cursor'
assert_eq 1 "$(grep -c '^show_cursor$' "$terminal_log")" 'dashboard leave is idempotent'
rm -rf "$fake_gum_dir"

rm -f "$state"
if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer dashboard tests passed.\n'
