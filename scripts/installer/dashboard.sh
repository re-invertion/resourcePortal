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

  if [[ "$mode" == primary ]] && declare -F rp_primary_phase_names >/dev/null; then
    mapfile -t RP_DASHBOARD_PHASES < <(rp_primary_phase_names)
  fi

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
}
