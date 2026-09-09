#!/usr/bin/env bash

declare -ag RP_DASHBOARD_PHASES=()
declare -Ag RP_DASHBOARD_STATUS=()
declare -ag RP_DASHBOARD_ACTIVITY=()
RP_DASHBOARD_MODE="${RP_DASHBOARD_MODE:-}"
RP_DASHBOARD_STATE_FILE="${RP_DASHBOARD_STATE_FILE:-}"
RP_DASHBOARD_OPERATION="${RP_DASHBOARD_OPERATION:-}"
RP_DASHBOARD_BLOCK_DETAIL="${RP_DASHBOARD_BLOCK_DETAIL:-}"
RP_DASHBOARD_ACTIVITY_MAX="${RP_DASHBOARD_ACTIVITY_MAX:-7}"

rp_dashboard_mode_label() {
  case "$1" in
    primary) printf 'Primary\n' ;;
    add-node) printf 'Add Node\n' ;;
    upgrade) printf 'Upgrade\n' ;;
    reconfigure) printf 'Reconfigure\n' ;;
    diagnostics) printf 'Diagnostics\n' ;;
    repair) printf 'Repair\n' ;;
    reset) printf 'Reset\n' ;;
    reset-factory) printf 'Factory Reset\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

rp_dashboard_init() {
  local mode="$1" state_file="$2" phase
  RP_DASHBOARD_MODE="$mode"
  RP_DASHBOARD_STATE_FILE="$state_file"
  RP_DASHBOARD_OPERATION=''
  RP_DASHBOARD_BLOCK_DETAIL=''
  RP_DASHBOARD_PHASES=()
  RP_DASHBOARD_ACTIVITY=()
  RP_DASHBOARD_STATUS=()

  case "$mode" in
    primary)
      if declare -F rp_primary_phase_names >/dev/null; then
        mapfile -t RP_DASHBOARD_PHASES < <(rp_primary_phase_names)
      fi
      ;;
    add-node) RP_DASHBOARD_PHASES=(packages docker enrollment) ;;
    upgrade) RP_DASHBOARD_PHASES=(preflight apply) ;;
    reconfigure) RP_DASHBOARD_PHASES=(apply) ;;
    diagnostics) RP_DASHBOARD_PHASES=(inspect) ;;
    repair) RP_DASHBOARD_PHASES=(repair) ;;
    reset) RP_DASHBOARD_PHASES=(apply) ;;
    reset-factory)
      if declare -F rp_factory_reset_phase_names >/dev/null; then
        mapfile -t RP_DASHBOARD_PHASES < <(rp_factory_reset_phase_names)
      fi
      ;;
  esac

  for phase in "${RP_DASHBOARD_PHASES[@]}"; do
    if [[ -r "$state_file" ]] && grep -Fxq -- "$phase" "$state_file"; then
      RP_DASHBOARD_STATUS["$phase"]='completed'
    else
      RP_DASHBOARD_STATUS["$phase"]='pending'
    fi
  done
}

rp_dashboard_phase_status() {
  local phase="$1"
  printf '%s\n' "${RP_DASHBOARD_STATUS[$phase]:-pending}"
}

rp_dashboard_progress_percent() {
  local phase completed=0 total=${#RP_DASHBOARD_PHASES[@]}
  (( total > 0 )) || { printf '0\n'; return 0; }
  for phase in "${RP_DASHBOARD_PHASES[@]}"; do
    [[ "${RP_DASHBOARD_STATUS[$phase]:-pending}" == completed ]] && completed=$((completed + 1))
  done
  printf '%d\n' "$(( completed * 100 / total ))"
}

rp_dashboard_activity_add() {
  local message="$1" max="${RP_DASHBOARD_ACTIVITY_MAX:-7}"
  [[ -n "$message" ]] || return 0
  RP_DASHBOARD_ACTIVITY+=("$message")
  while (( ${#RP_DASHBOARD_ACTIVITY[@]} > max )); do
    RP_DASHBOARD_ACTIVITY=("${RP_DASHBOARD_ACTIVITY[@]:1}")
  done
}

rp_dashboard_event() {
  local event="$1" scope="$2" message="$3"
  case "$event" in
    phase_started)
      RP_DASHBOARD_STATUS["$scope"]='running'
      RP_DASHBOARD_OPERATION="$message"
      RP_DASHBOARD_BLOCK_DETAIL=''
      ;;
    phase_completed)
      RP_DASHBOARD_STATUS["$scope"]='completed'
      RP_DASHBOARD_OPERATION="$message"
      RP_DASHBOARD_BLOCK_DETAIL=''
      rp_dashboard_activity_add "$message"
      ;;
    phase_failed)
      RP_DASHBOARD_STATUS["$scope"]='failed'
      RP_DASHBOARD_OPERATION="$message"
      RP_DASHBOARD_BLOCK_DETAIL=''
      rp_dashboard_activity_add "$message"
      ;;
    phase_blocked)
      RP_DASHBOARD_STATUS["$scope"]='blocked'
      RP_DASHBOARD_OPERATION="$message"
      RP_DASHBOARD_BLOCK_DETAIL="$message"
      rp_dashboard_activity_add "$message"
      ;;
    phase_unblocked)
      RP_DASHBOARD_STATUS["$scope"]='running'
      RP_DASHBOARD_OPERATION="$message"
      RP_DASHBOARD_BLOCK_DETAIL=''
      rp_dashboard_activity_add "$message"
      ;;
    operation_started|operation_updated)
      RP_DASHBOARD_OPERATION="$message"
      ;;
    activity)
      rp_dashboard_activity_add "$message"
      ;;
  esac
  if [[ "${RP_UI_MODE:-text}" == tui && "${RP_DASHBOARD_ENTERED:-false}" == true ]] && declare -F rp_dashboard_render >/dev/null; then
    rp_dashboard_render
  fi
}

rp_dashboard_status_symbol() {
  case "$1" in
    completed) printf '✓' ;;
    running) printf '●' ;;
    pending) printf '○' ;;
    blocked) printf '!' ;;
    failed) printf '✗' ;;
    *) printf '?' ;;
  esac
}

rp_dashboard_render_text() {
  local phase status
  printf 'Mode: %s\n' "$(rp_dashboard_mode_label "$RP_DASHBOARD_MODE")"
  printf 'Progress: %s%%\n' "$(rp_dashboard_progress_percent)"
  for phase in "${RP_DASHBOARD_PHASES[@]}"; do
    status="${RP_DASHBOARD_STATUS[$phase]:-pending}"
    printf '%s %s\n' "$(rp_dashboard_status_symbol "$status")" "$phase"
  done
  [[ -n "$RP_DASHBOARD_OPERATION" ]] && printf 'Current: %s\n' "$RP_DASHBOARD_OPERATION"
  return 0
}

RP_DASHBOARD_ENTERED="${RP_DASHBOARD_ENTERED:-false}"

rp_dashboard_terminal_action() {
  case "$1" in
    enter_alt) printf '\033[?1049h' >&2 ;;
    leave_alt) printf '\033[?1049l' >&2 ;;
    hide_cursor) printf '\033[?25l' >&2 ;;
    show_cursor) printf '\033[?25h' >&2 ;;
    clear) printf '\033[2J\033[H' >&2 ;;
    home) printf '\033[H' >&2 ;;
    reset) printf '\033[0m' >&2 ;;
  esac
}

rp_dashboard_stage_lines() {
  local phase status
  for phase in "${RP_DASHBOARD_PHASES[@]}"; do
    status="${RP_DASHBOARD_STATUS[$phase]:-pending}"
    printf '%s %s\n' "$(rp_dashboard_status_symbol "$status")" "$phase"
  done
}

rp_dashboard_activity_lines() {
  local item
  if (( ${#RP_DASHBOARD_ACTIVITY[@]} == 0 )); then
    printf 'No recent activity\n'
    return
  fi
  for item in "${RP_DASHBOARD_ACTIVITY[@]}"; do printf '%s\n' "$item"; done
}

rp_dashboard_gum_style() {
  local content="$1"; shift
  if [[ -n "${RP_GUM_BIN:-}" && -x "$RP_GUM_BIN" ]]; then
    "$RP_GUM_BIN" style "$@" "$content"
  else
    printf '%s\n' "$content"
  fi
}

rp_dashboard_gum_join() {
  local direction="$1"; shift
  if [[ -n "${RP_GUM_BIN:-}" && -x "$RP_GUM_BIN" ]]; then
    "$RP_GUM_BIN" join "--$direction" "$@"
  else
    printf '%s\n' "$@"
  fi
}

rp_dashboard_render() {
  [[ "${RP_UI_MODE:-text}" == tui ]] || return 0
  local cols header stage_text operation_text activity_text stage_panel operation_panel body activity_panel progress host
  cols="$(tput cols 2>/dev/null || printf '100')"
  [[ "$cols" =~ ^[0-9]+$ ]] || cols=100
  progress="$(rp_dashboard_progress_percent)"
  host="$(hostname 2>/dev/null || printf unknown)"
  header=$'ResourcePortal Production Installer\n'
  header+="Mode: $(rp_dashboard_mode_label "$RP_DASHBOARD_MODE")    Host: $host    Progress: ${progress}%"
  stage_text="$(rp_dashboard_stage_lines)"
  operation_text="${RP_DASHBOARD_OPERATION:-Waiting for next operation}"
  if [[ -n "${RP_DASHBOARD_BLOCK_DETAIL:-}" ]]; then
    operation_text+=$'\n\nBlocked: '
    operation_text+="$RP_DASHBOARD_BLOCK_DETAIL"
  fi
  activity_text="$(rp_dashboard_activity_lines)"

  header="$(rp_dashboard_gum_style "$header" --bold --padding '0 1')"
  stage_panel="$(rp_dashboard_gum_style "$stage_text" --border rounded --padding '0 1')"
  operation_panel="$(rp_dashboard_gum_style "$operation_text" --border rounded --padding '0 1')"
  activity_panel="$(rp_dashboard_gum_style "$activity_text" --border rounded --padding '0 1')"
  if (( cols >= 80 )); then
    body="$(rp_dashboard_gum_join horizontal "$stage_panel" "$operation_panel")"
  else
    body="$(rp_dashboard_gum_join vertical "$stage_panel" "$operation_panel")"
  fi
  if [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]]; then rp_dashboard_terminal_action home; rp_dashboard_terminal_action clear; fi
  printf '%s\n%s\n%s\n' "$header" "$body" "$activity_panel" >&2
}

rp_dashboard_enter() {
  [[ "${RP_UI_MODE:-text}" == tui ]] || return 0
  [[ "${RP_DASHBOARD_ENTERED:-false}" != true ]] || return 0
  RP_DASHBOARD_ENTERED=true
  export RP_DASHBOARD_ENTERED
  rp_dashboard_terminal_action enter_alt
  rp_dashboard_terminal_action hide_cursor
  rp_dashboard_terminal_action clear
  rp_dashboard_render
}

rp_dashboard_leave() {
  [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]] || return 0
  rp_dashboard_terminal_action reset
  rp_dashboard_terminal_action show_cursor
  rp_dashboard_terminal_action leave_alt
  RP_DASHBOARD_ENTERED=false
  export RP_DASHBOARD_ENTERED
}

rp_dashboard_log_tail() {
  local log_file="${1:-${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}}" lines="${2:-40}"
  [[ "$lines" =~ ^[0-9]+$ ]] || lines=40
  (( lines > 0 )) || lines=40
  [[ -r "$log_file" ]] || { printf 'Installer log is not readable: %s\n' "$log_file"; return 0; }
  tail -n "$lines" "$log_file"
}

rp_dashboard_failure_text() {
  local phase="$1" summary="$2"
  printf 'Installation failed\n'
  printf 'Stage: %s\n' "$phase"
  printf 'Error: %s\n' "$summary"
  printf 'Log: %s\n' "${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}"
  printf '\nActions:\n'
  printf 'Retry\nView details\nExit\n'
}

rp_dashboard_render_failure() {
  local phase="$1" summary="$2" text
  text="$(rp_dashboard_failure_text "$phase" "$summary")"
  if [[ "${RP_UI_MODE:-text}" == tui ]]; then
    rp_dashboard_gum_style "$text" --border rounded --padding '1 2' >&2
  else
    printf '%s\n' "$text" >&2
  fi
}

rp_dashboard_control_plane_summary() {
  local stack_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}" summary
  if [[ -n "${RP_DASHBOARD_SERVICE_SUMMARY:-}" ]]; then
    printf '%s\n' "$RP_DASHBOARD_SERVICE_SUMMARY"
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    summary="$(docker service ls --filter "label=com.docker.stack.namespace=$stack_name" --format '{{.Name}} {{.Replicas}}' 2>/dev/null | paste -sd ', ' - || true)"
  fi
  printf '%s\n' "${summary:-unavailable}"
}

rp_dashboard_completion_text() {
  local mode="$1" service_summary enrollment smtp retained=''
  if [[ "$mode" == reset-factory ]]; then
    if [[ "${RP_FACTORY_PLAN_DOCKER_REMOVE:-false}" != true ]]; then
      retained='Docker (ownership unproven)'
    fi
    if [[ "${RP_FACTORY_PLAN_PACKAGE_TRACKING:-tracked}" == legacy-untracked && "${RP_FACTORY_PLAN_FORCE_UNTRACKED_PACKAGES:-false}" != true ]]; then
      if [[ -n "$retained" ]]; then retained+=', '; fi
      retained+='untracked host packages'
    fi
    printf 'Factory reset status: COMPLETE\n'
    printf 'ResourcePortal data and storage were destroyed.\n'
    printf 'Swarm membership: removed\n'
    if [[ -n "$retained" ]]; then printf 'Retained: %s\n' "$retained"; else printf 'Retained: none\n'; fi
    return 0
  fi
  if [[ "$mode" != primary ]]; then
    printf 'Operation status: COMPLETE\nMode: %s\nLog: %s\n' \
      "$(rp_dashboard_mode_label "$mode")" "${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}"
    return 0
  fi
  service_summary="$(rp_dashboard_control_plane_summary)"
  if [[ -n "${RP_CFG_ENROLLMENT_PIN:-}" ]]; then enrollment='ready'; else enrollment='not ready'; fi
  if [[ "${RP_CFG_SMTP_DEFERRED:-false}" == true ]]; then smtp='deferred'; else smtp='configured'; fi
  printf 'Installation status: COMPLETE\n'
  printf 'Release: %s\n' "${RP_CFG_RELEASE_VERSION:-unknown}"
  printf 'Web: https://%s\n' "${RP_CFG_DOMAIN:-unknown}"
  printf 'Auth: https://%s\n' "${RP_CFG_ZITADEL_DOMAIN:-unknown}"
  printf 'Control plane: %s\n' "$service_summary"
  printf 'Enrollment: %s\n' "$enrollment"
  printf 'SMTP: %s\n' "$smtp"
  printf 'Log: %s\n' "${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}"
}

rp_dashboard_complete() {
  local mode="$1" text
  [[ "${RP_UI_MODE:-text}" == tui ]] || return 0
  text="$(rp_dashboard_completion_text "$mode")"
  if [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]]; then
    rp_dashboard_leave || true
  fi
  rp_dashboard_gum_style "$text" --border rounded --padding '1 2' >&2
}
