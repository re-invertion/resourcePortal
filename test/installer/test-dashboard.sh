#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/ui.sh"
source "$repo_root/scripts/installer/lifecycle.sh"
source "$repo_root/scripts/installer/reset.sh"
[[ -r "$repo_root/scripts/installer/dashboard.sh" ]] && source "$repo_root/scripts/installer/dashboard.sh"

failures=0
assert_eq(){ local e="$1" a="$2" n="$3"; if [[ "$e" == "$a" ]]; then printf 'PASS: %s\n' "$n"; else printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$n" "$e" "$a" >&2; failures=$((failures+1)); fi; }
assert_contains(){ local h="$1" n="$2" t="$3"; if [[ "$h" == *"$n"* ]]; then printf 'PASS: %s\n' "$t"; else printf 'FAIL: %s\nmissing: %s\n' "$t" "$n" >&2; failures=$((failures+1)); fi; }
assert_not_contains(){ local h="$1" n="$2" t="$3"; if [[ "$h" != *"$n"* ]]; then printf 'PASS: %s\n' "$t"; else printf 'FAIL: %s\nunexpected: %s\n' "$t" "$n" >&2; failures=$((failures+1)); fi; }

state="$(mktemp)"
printf 'preflight\npackages\n' >"$state"
rp_primary_phase_names(){ printf '%s\n' preflight packages dns ingress; }
rp_dashboard_init primary "$state"
assert_eq 50 "$(rp_dashboard_progress_percent)" 'resume progress is checkpoint based'
assert_eq completed "$(rp_dashboard_phase_status preflight)" 'checkpoint marks completed'
assert_eq pending "$(rp_dashboard_phase_status dns)" 'uncheckpointed phase starts pending'

rp_dashboard_init add-node /dev/null
assert_eq 'packages docker enrollment' "${RP_DASHBOARD_PHASES[*]}" 'add-node dashboard exposes ordered phases'
assert_eq 0 "$(rp_dashboard_progress_percent)" 'add-node starts at zero progress'
rp_dashboard_event phase_completed packages 'Host packages ready'
assert_eq 33 "$(rp_dashboard_progress_percent)" 'add-node progress advances by completed phase'
rp_dashboard_init upgrade /dev/null
assert_eq 'preflight apply' "${RP_DASHBOARD_PHASES[*]}" 'upgrade dashboard exposes ordered phases'
rp_dashboard_init reconfigure /dev/null
assert_eq 'apply' "${RP_DASHBOARD_PHASES[*]}" 'reconfigure dashboard exposes apply phase'
rp_dashboard_init diagnostics /dev/null
assert_eq 'inspect' "${RP_DASHBOARD_PHASES[*]}" 'diagnostics dashboard exposes inspect phase'
rp_dashboard_init repair /dev/null
assert_eq 'repair' "${RP_DASHBOARD_PHASES[*]}" 'repair dashboard exposes repair phase'

# Restore Primary model for the remaining assertions.
rp_dashboard_init primary "$state"

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

logged_tmp="$(mktemp -d)"
(
  RP_INSTALLER_LOG_FILE="$logged_tmp/installer.log"
  : >"$RP_INSTALLER_LOG_FILE"
  RP_UI_MODE=tui
  rp_ui_event(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$logged_tmp/events"; }
  noisy_command(){ printf 'command-stdout\n'; printf 'command-stderr\n' >&2; return 7; }
  set +e
  rp_run_logged_operation migration 'Applying database migrations' noisy_command >"$logged_tmp/screen.out" 2>"$logged_tmp/screen.err"
  printf '%s\n' "$?" >"$logged_tmp/status"
  set -e
)
assert_eq 7 "$(cat "$logged_tmp/status")" 'logged operation preserves command status'
logged_text="$(cat "$logged_tmp/installer.log")"
assert_contains "$logged_text" 'command-stdout' 'logged operation captures stdout'
assert_contains "$logged_text" 'command-stderr' 'logged operation captures stderr'
assert_eq '' "$(cat "$logged_tmp/screen.out")" 'TUI hides raw command stdout'
assert_eq '' "$(cat "$logged_tmp/screen.err")" 'TUI hides raw command stderr'
assert_contains "$(cat "$logged_tmp/events")" 'operation_started|migration|Applying database migrations' 'logged operation emits safe operation event'
test_secret='do-not-leak-123'
assert_not_contains "$(cat "$logged_tmp/events")" "$test_secret" 'operation event excludes unrelated secret values'
rm -rf "$logged_tmp"

details_log="$(mktemp)"
for i in $(seq 1 100); do printf 'safe-line-%03d\n' "$i"; done >"$details_log"
details_tail="$(rp_dashboard_log_tail "$details_log" 40)"
assert_eq 40 "$(printf '%s\n' "$details_tail" | wc -l | tr -d ' ')" 'details view is bounded to requested tail'
assert_contains "$details_tail" 'safe-line-100' 'details view includes newest log line'
if [[ "$details_tail" == *'safe-line-060'* ]]; then printf 'FAIL: details view includes line outside bounded tail\n' >&2; failures=$((failures+1)); else printf 'PASS: details view excludes lines outside bounded tail\n'; fi
failure_text="$(rp_dashboard_failure_text dns 'DNS resolver failed')"
assert_contains "$failure_text" 'Retry' 'failure screen offers Retry'
assert_contains "$failure_text" 'View details' 'failure screen offers View details'
assert_contains "$failure_text" 'Exit' 'failure screen offers Exit'
rm -f "$details_log"



if declare -F rp_dashboard_completion_text >/dev/null; then
  RP_CFG_RELEASE_VERSION='0.1.0'
  RP_CFG_DOMAIN='rp.example.test'
  RP_CFG_ZITADEL_DOMAIN='auth.rp.example.test'
  RP_CFG_ENROLLMENT_PIN='sha256:test-pin'
  RP_CFG_SMTP_DEFERRED=true
  RP_DASHBOARD_SERVICE_SUMMARY='API 1/1, Web 1/1, ZITADEL 1/1'
  RP_ADMIN_PASSWORD='CompletionSecret1!'
  RP_INTERNAL_WORKER_TOKEN='completion-token-secret'
  noninteractive_completion_marker="$(mktemp)"
rm -f "$noninteractive_completion_marker"
(
  RP_UI_MODE=tui
  RP_NON_INTERACTIVE=true
  export RP_UI_MODE RP_NON_INTERACTIVE
  rp_dashboard_completion_text(){ : >"$noninteractive_completion_marker"; printf 'should-not-render\n'; }
  rp_dashboard_gum_style(){ return 0; }
  rp_dashboard_complete primary
)
if [[ ! -e "$noninteractive_completion_marker" ]]; then
  printf 'PASS: %s\n' 'non-interactive completion skips TUI rendering'
else
  printf 'FAIL: %s\n' 'non-interactive completion skips TUI rendering' >&2
  failures=$((failures+1))
fi
rm -f "$noninteractive_completion_marker"

completion_text="$(rp_dashboard_completion_text primary)"
  assert_contains "$completion_text" 'Installation status: COMPLETE' 'completion shows installation status'
  assert_contains "$completion_text" 'Release: 0.1.0' 'completion shows release version'
  assert_contains "$completion_text" 'https://rp.example.test' 'completion shows web URL'
  assert_contains "$completion_text" 'https://auth.rp.example.test' 'completion shows auth URL'
  assert_contains "$completion_text" 'API 1/1, Web 1/1, ZITADEL 1/1' 'completion shows service summary'
  assert_contains "$completion_text" 'Enrollment: ready' 'completion shows enrollment readiness'
  assert_contains "$completion_text" '/var/log/resourceportal/installer.log' 'completion shows log path'
  assert_contains "$completion_text" 'SMTP: deferred' 'completion shows deferred SMTP'
  RP_CFG_ACME_ENVIRONMENT='staging'
  staging_completion="$(rp_dashboard_completion_text primary)"
  assert_contains "$staging_completion" "TLS: Let's Encrypt staging (NOT publicly trusted)" 'staging completion is visibly non-production'
  RP_CFG_ACME_ENVIRONMENT='production'
  production_completion="$(rp_dashboard_completion_text primary)"
  assert_contains "$production_completion" "TLS: Let's Encrypt production" 'production completion identifies trusted ACME mode'
  assert_not_contains "$completion_text" "$RP_ADMIN_PASSWORD" 'completion excludes admin password'
  assert_not_contains "$completion_text" "$RP_INTERNAL_WORKER_TOKEN" 'completion excludes worker token'
  unset RP_ADMIN_PASSWORD RP_INTERNAL_WORKER_TOKEN RP_DASHBOARD_SERVICE_SUMMARY
else
  printf 'FAIL: completion renderer exists\n' >&2; failures=$((failures+1))
fi


factory_state="$(mktemp)"
assert_eq 'Factory Reset' "$(rp_dashboard_mode_label reset-factory)" 'factory reset has destructive mode label'
rp_dashboard_init reset-factory "$factory_state"
assert_contains "${RP_DASHBOARD_PHASES[*]}" 'wipe-storage' 'factory dashboard phase list includes storage wipe'
assert_eq pending "$(rp_dashboard_phase_status wipe-storage)" 'factory dashboard includes storage wipe phase'
factory_render="$(rp_dashboard_render_text)"
assert_contains "$factory_render" 'Mode: Factory Reset' 'factory dashboard visibly labels destructive mode'
factory_completion="$(rp_dashboard_completion_text reset-factory)"
assert_contains "$factory_completion" 'ResourcePortal data and storage were destroyed' 'factory completion states destructive result'
rm -f "$factory_state"

rm -f "$state"
if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer dashboard tests passed.\n'
