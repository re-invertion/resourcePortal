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
