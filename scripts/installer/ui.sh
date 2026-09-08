#!/usr/bin/env bash

RP_UI_MODE="${RP_UI_MODE:-text}"

rp_ui_has_tty() {
  [[ -t 0 && -t 1 && -t 2 ]]
}

rp_ui_mode_select() {
  local non_interactive="${1:-false}"
  if [[ "$non_interactive" == true ]] || ! rp_ui_has_tty; then
    printf 'text\n'
  else
    printf 'tui\n'
  fi
}

rp_ui_mode() {
  printf '%s\n' "${RP_UI_MODE:-text}"
}

rp_ui_event() {
  local event="$1" scope="$2" message="$3"
  if [[ "${RP_UI_MODE:-text}" == tui ]] && declare -F rp_dashboard_event >/dev/null; then
    rp_dashboard_event "$event" "$scope" "$message"
    return
  fi
  printf '[%s] %s\n' "$scope" "$message" >&2
}

rp_ui_init() {
  RP_UI_MODE="$(rp_ui_mode_select "${RP_NON_INTERACTIVE:-false}")"
  export RP_UI_MODE
}

rp_ui_cleanup() {
  :
}

rp_ui_backend() {
  if command -v dialog >/dev/null 2>&1; then
    printf 'dialog\n'
  elif command -v whiptail >/dev/null 2>&1; then
    printf 'whiptail\n'
  else
    printf 'terminal\n'
  fi
}

rp_ui_message() {
  local title="$1" message="$2" backend
  backend="$(rp_ui_backend)"
  case "$backend" in
    dialog) dialog --title "$title" --msgbox "$message" 10 72 ;;
    whiptail) whiptail --title "$title" --msgbox "$message" 10 72 ;;
    *) printf '\n%s\n%s\n' "$title" "$message" ;;
  esac
}

rp_ui_input() {
  local title="$1" prompt="$2" default="${3:-}" backend result
  backend="$(rp_ui_backend)"
  case "$backend" in
    dialog) result="$(dialog --stdout --title "$title" --inputbox "$prompt" 10 72 "$default")" || return 1 ;;
    whiptail) result="$(whiptail --title "$title" --inputbox "$prompt" 10 72 "$default" 3>&1 1>&2 2>&3)" || return 1 ;;
    *) printf '%s [%s]: ' "$prompt" "$default" >&2; IFS= read -r result; [[ -n "$result" ]] || result="$default" ;;
  esac
  printf '%s\n' "$result"
}

rp_ui_password() {
  local title="$1" prompt="$2" backend result
  backend="$(rp_ui_backend)"
  case "$backend" in
    dialog) result="$(dialog --stdout --title "$title" --insecure --passwordbox "$prompt" 10 72)" || return 1 ;;
    whiptail) result="$(whiptail --title "$title" --passwordbox "$prompt" 10 72 3>&1 1>&2 2>&3)" || return 1 ;;
    *) printf '%s: ' "$prompt" >&2; IFS= read -rs result; printf '\n' >&2 ;;
  esac
  printf '%s\n' "$result"
}

rp_ui_choice() {
  local title="$1" prompt="$2"; shift 2
  local backend result first="${1:-}"
  [[ $# -ge 1 ]] || return 2
  shift
  backend="$(rp_ui_backend)"
  case "$backend" in
    dialog) result="$(dialog --stdout --title "$title" --menu "$prompt" 18 78 10 "$@")" || return 1 ;;
    whiptail) result="$(whiptail --title "$title" --menu "$prompt" 18 78 10 "$@" 3>&1 1>&2 2>&3)" || return 1 ;;
    *)
      printf '%s\n' "$prompt" >&2
      while (($# >= 2)); do printf '  %s - %s\n' "$1" "$2" >&2; shift 2; done
      printf 'Choice [%s]: ' "$first" >&2; IFS= read -r result; [[ -n "$result" ]] || result="$first"
      ;;
  esac
  printf '%s\n' "$result"
}
