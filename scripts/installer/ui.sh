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
  local non_interactive="${1:-false}" has_tty="${2:-}"
  if [[ -z "$has_tty" ]]; then
    if rp_ui_has_tty; then has_tty=true; else has_tty=false; fi
  fi
  if [[ "$non_interactive" == true || "$has_tty" != true ]]; then
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
  else
    rc=$?
  fi
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
  local rc has_tty=false
  if rp_ui_has_tty; then has_tty=true; fi
  RP_UI_MODE="$(rp_ui_mode_select "${RP_NON_INTERACTIVE:-false}" "$has_tty")"
  RP_UI_TUI_PENDING=false
  export RP_UI_MODE RP_UI_TUI_PENDING
  if [[ "$RP_UI_MODE" == tui ]]; then
    if rp_ui_ensure_gum; then
      return 0
    else
      rc=$?
    fi
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
  if [[ "${RP_UI_MODE:-text}" == tui && -n "${RP_GUM_BIN:-}" && -x "$RP_GUM_BIN" ]]; then
    printf 'gum\n'
  else
    printf 'terminal\n'
  fi
}

rp_ui_prompt_begin() {
  RP_UI_PROMPT_RESTORE_DASHBOARD=false
  if [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]] && declare -F rp_dashboard_leave >/dev/null; then
    rp_dashboard_leave || true
    RP_UI_PROMPT_RESTORE_DASHBOARD=true
  fi
}

rp_ui_prompt_end() {
  if [[ "${RP_UI_PROMPT_RESTORE_DASHBOARD:-false}" == true ]] && declare -F rp_dashboard_enter >/dev/null; then
    rp_dashboard_enter || true
  elif [[ "${RP_UI_MODE:-text}" == tui ]] && declare -F rp_dashboard_render >/dev/null && [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]]; then
    rp_dashboard_render || true
  fi
  RP_UI_PROMPT_RESTORE_DASHBOARD=false
}

rp_ui_message() {
  local title="$1" message="$2" backend
  backend="$(rp_ui_backend)"
  case "$backend" in
    gum)
      rp_ui_prompt_begin
      "$RP_GUM_BIN" style --border rounded --padding '1 2' "$title"$'\n'"$message" >&2
      rp_ui_prompt_end
      ;;
    *) printf '\n%s\n%s\n' "$title" "$message" >&2 ;;
  esac
}

rp_ui_input() {
  local title="$1" prompt="$2" default="${3:-}" backend result rc
  backend="$(rp_ui_backend)"
  case "$backend" in
    gum)
      rp_ui_prompt_begin
      if result="$("$RP_GUM_BIN" input --header "$title" --prompt "$prompt: " --value "$default")"; then rc=0; else rc=$?; fi
      rp_ui_prompt_end
      (( rc == 0 )) || return "$rc"
      ;;
    *)
      printf '%s [%s]: ' "$prompt" "$default" >&2
      IFS= read -r result || true
      [[ -n "$result" ]] || result="$default"
      ;;
  esac
  printf '%s\n' "$result"
}

rp_ui_password() {
  local title="$1" prompt="$2" backend result rc
  backend="$(rp_ui_backend)"
  case "$backend" in
    gum)
      rp_ui_prompt_begin
      if result="$("$RP_GUM_BIN" input --header "$title" --prompt "$prompt: " --password)"; then rc=0; else rc=$?; fi
      rp_ui_prompt_end
      (( rc == 0 )) || return "$rc"
      ;;
    *)
      printf '%s: ' "$prompt" >&2
      IFS= read -rs result || true
      printf '\n' >&2
      ;;
  esac
  printf '%s\n' "$result"
}

rp_ui_choice() {
  local title="$1" prompt="$2"; shift 2
  local backend result default="${1:-}" value label default_label='' rc
  local -a options=()
  [[ $# -ge 1 ]] || return 2
  shift
  while (($# >= 2)); do
    value="$1"; label="$2"; shift 2
    options+=("${label}:::${value}")
    [[ "$value" == "$default" ]] && default_label="$label"
  done
  backend="$(rp_ui_backend)"
  case "$backend" in
    gum)
      rp_ui_prompt_begin
      if result="$("$RP_GUM_BIN" choose --header "$title - $prompt" --label-delimiter ':::' --selected "$default_label" "${options[@]}")"; then rc=0; else rc=$?; fi
      rp_ui_prompt_end
      (( rc == 0 )) || return "$rc"
      ;;
    *)
      printf '%s\n' "$prompt" >&2
      for value in "${options[@]}"; do
        label="${value%%:::*}"; value="${value#*:::}"
        printf '  %s - %s\n' "$value" "$label" >&2
      done
      printf 'Choice [%s]: ' "$default" >&2
      IFS= read -r result || true
      [[ -n "$result" ]] || result="$default"
      ;;
  esac
  printf '%s\n' "$result"
}

rp_ui_confirm() {
  local title="$1" prompt="$2" backend rc
  backend="$(rp_ui_backend)"
  case "$backend" in
    gum)
      rp_ui_prompt_begin
      if "$RP_GUM_BIN" confirm "$title: $prompt"; then rc=0; else rc=$?; fi
      rp_ui_prompt_end
      return "$rc"
      ;;
    *)
      local answer
      printf '%s - %s [Y/n]: ' "$title" "$prompt" >&2
      IFS= read -r answer || true
      case "${answer:-y}" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
      ;;
  esac
}

rp_ui_show_log_details() {
  local details
  if declare -F rp_dashboard_log_tail >/dev/null; then
    details="$(rp_dashboard_log_tail "${RP_INSTALLER_LOG_FILE:-/var/log/resourceportal/installer.log}" 40)"
  else
    details="Installer log details are unavailable."
  fi
  if [[ "$(rp_ui_backend)" == gum ]]; then
    rp_ui_prompt_begin
    "$RP_GUM_BIN" pager "$details" || true
    rp_ui_prompt_end
  else
    printf '%s\n' "$details" >&2
  fi
}

rp_ui_failure_action() {
  local phase="$1" summary="$2" action
  [[ "${RP_UI_MODE:-text}" == tui ]] || { printf 'exit\n'; return 0; }
  while true; do
    if declare -F rp_dashboard_render_failure >/dev/null; then rp_dashboard_render_failure "$phase" "$summary"; fi
    action="$(rp_ui_choice 'Installation failed' "$summary" retry \
      retry 'Retry' \
      details 'View details' \
      exit 'Exit')" || { printf 'exit\n'; return 0; }
    case "$action" in
      retry|exit) printf '%s\n' "$action"; return 0 ;;
      details) rp_ui_show_log_details ;;
      *) printf 'exit\n'; return 0 ;;
    esac
  done
}

rp_ui_mode_dashboard_start() {
  local mode="$1"
  [[ "${RP_UI_MODE:-text}" == tui ]] || return 0
  declare -F rp_dashboard_init >/dev/null || return 0
  if [[ "${RP_DASHBOARD_ENTERED:-false}" == true && "${RP_DASHBOARD_MODE:-}" == "$mode" ]]; then
    return 0
  fi
  if [[ "${RP_DASHBOARD_ENTERED:-false}" == true ]] && declare -F rp_dashboard_leave >/dev/null; then
    rp_dashboard_leave || true
  fi
  rp_dashboard_init "$mode" /dev/null
  if declare -F rp_dashboard_enter >/dev/null; then rp_dashboard_enter || true; fi
}

rp_ui_mode_operation() {
  local mode="$1" phase="$2" message="$3" rc
  shift 3
  if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_started "$phase" "$message" || true; fi
  if "$@"; then
    if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_completed "$phase" "$message completed" || true; fi
    return 0
  else
    rc=$?
  fi
  if declare -F rp_ui_event >/dev/null; then rp_ui_event phase_failed "$phase" "$message failed" || true; fi
  return "$rc"
}
