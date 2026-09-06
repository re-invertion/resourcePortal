#!/usr/bin/env bash

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
