#!/usr/bin/env bash

RP_UI_MODE="${RP_UI_MODE:-text}"
RP_UI_TUI_PENDING="${RP_UI_TUI_PENDING:-false}"
RP_GUM_VERSION="${RP_GUM_VERSION:-v0.17.0}"
RP_GUM_INSTALL_DIR="${RP_GUM_INSTALL_DIR:-/var/lib/resourceportal/installer-ui}"
RP_GUM_BIN="${RP_GUM_BIN:-}"

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

rp_ui_arch() {
  local arch
  if command -v dpkg >/dev/null 2>&1; then arch="$(dpkg --print-architecture 2>/dev/null || true)"; fi
  [[ -n "${arch:-}" ]] || arch="$(uname -m 2>/dev/null || true)"
  case "$arch" in
    amd64|x86_64) printf 'amd64\n' ;;
    arm64|aarch64) printf 'arm64\n' ;;
    *) return 1 ;;
  esac
}

rp_ui_gum_asset() {
  case "$1" in
    amd64) printf 'gum_0.17.0_Linux_x86_64.tar.gz\n' ;;
    arm64) printf 'gum_0.17.0_Linux_arm64.tar.gz\n' ;;
    *) return 1 ;;
  esac
}

rp_ui_gum_expected_sha256() {
  case "$1" in
    amd64) printf '69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb\n' ;;
    arm64) printf 'b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c\n' ;;
    *) return 1 ;;
  esac
}

rp_ui_gum_version_ok() {
  local bin="$1" version
  [[ -x "$bin" ]] || return 1
  version="$("$bin" --version 2>/dev/null || true)"
  [[ "$version" == *'0.17.0'* ]]
}

rp_ui_ensure_gum() {
  local arch asset expected actual url tmp archive extracted existing
  if [[ -n "${RP_GUM_BIN:-}" ]] && rp_ui_gum_version_ok "$RP_GUM_BIN"; then return 0; fi
  existing="$(command -v gum 2>/dev/null || true)"
  if [[ -n "$existing" ]] && rp_ui_gum_version_ok "$existing"; then
    RP_GUM_BIN="$existing"; export RP_GUM_BIN; return 0
  fi
  arch="$(rp_ui_arch)" || return 20
  asset="$(rp_ui_gum_asset "$arch")" || return 20
  expected="$(rp_ui_gum_expected_sha256 "$arch")" || return 20
  command -v curl >/dev/null 2>&1 || return 20
  command -v sha256sum >/dev/null 2>&1 || return 20
  command -v tar >/dev/null 2>&1 || return 20
  tmp="$(mktemp -d)" || return 20
  archive="$tmp/$asset"
  url="https://github.com/charmbracelet/gum/releases/download/${RP_GUM_VERSION}/${asset}"
  if ! curl -fsSL "$url" -o "$archive"; then rm -rf "$tmp"; return 20; fi
  actual="$(sha256sum "$archive" 2>/dev/null | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then rm -rf "$tmp"; return 21; fi
  mkdir -p "$tmp/extract"
  if ! tar -xzf "$archive" -C "$tmp/extract"; then rm -rf "$tmp"; return 20; fi
  extracted="$(find "$tmp/extract" -type f -name gum -print -quit 2>/dev/null || true)"
  [[ -n "$extracted" ]] || { rm -rf "$tmp"; return 20; }
  install -d -m 0755 "$RP_GUM_INSTALL_DIR" || { rm -rf "$tmp"; return 20; }
  RP_GUM_BIN="$RP_GUM_INSTALL_DIR/gum-0.17.0"
  install -m 0755 "$extracted" "$RP_GUM_BIN" || { rm -rf "$tmp"; return 20; }
  rm -rf "$tmp"
  rp_ui_gum_version_ok "$RP_GUM_BIN" || return 20
  export RP_GUM_BIN
}

rp_ui_try_enable_tui() {
  local rc
  [[ "${RP_NON_INTERACTIVE:-false}" != true ]] || return 0
  rp_ui_has_tty || return 0
  [[ "${RP_UI_MODE:-text}" != tui ]] || return 0
  if rp_ui_ensure_gum; then
    RP_UI_MODE=tui
    RP_UI_TUI_PENDING=false
    export RP_UI_MODE RP_UI_TUI_PENDING RP_GUM_BIN
    return 0
  fi
  rc=$?
  [[ $rc -eq 21 ]] && return 1
  RP_UI_MODE=text
  RP_UI_TUI_PENDING=false
  export RP_UI_MODE RP_UI_TUI_PENDING
  return 0
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
  local rc
  RP_UI_MODE="$(rp_ui_mode_select "${RP_NON_INTERACTIVE:-false}")"
  RP_UI_TUI_PENDING=false
  export RP_UI_MODE RP_UI_TUI_PENDING
  if [[ "$RP_UI_MODE" == tui ]]; then
    if rp_ui_ensure_gum; then
      return 0
    fi
    rc=$?
    [[ $rc -eq 21 ]] && return 1
    RP_UI_MODE=text
    RP_UI_TUI_PENDING=true
    export RP_UI_MODE RP_UI_TUI_PENDING
    if declare -F rp_log >/dev/null; then rp_log WARN 'Enhanced TUI unavailable during bootstrap; using text mode until prerequisites are available.'; fi
  fi
}

rp_ui_cleanup() {
  if declare -F rp_dashboard_leave >/dev/null; then rp_dashboard_leave || true; fi
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
