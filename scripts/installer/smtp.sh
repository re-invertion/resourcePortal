#!/usr/bin/env bash

rp_validate_smtp_mode() {
  case "${1,,}" in tls|starttls|plain) return 0 ;; *) return 1 ;; esac
}

rp_test_smtp() {
  local host="$1" port="$2" mode="$3" username="$4" password_file="$5" sender="$6" recipient="$7"
  local config message scheme
  rp_validate_smtp_mode "$mode" || return 1
  [[ "$port" =~ ^[0-9]+$ && -n "$host" && -n "$sender" && -n "$recipient" ]] || return 1
  if [[ -n "$username" ]]; then
    [[ "$password_file" == /* && -r "$password_file" ]] || return 1
  fi
  config="$(mktemp /tmp/resourceportal-smtp.XXXXXX.conf)"
  message="$(mktemp /tmp/resourceportal-smtp.XXXXXX.eml)"
  chmod 0600 "$config" "$message"
  trap 'rm -f "$config" "$message"' RETURN

  case "${mode,,}" in
    tls) scheme="smtps" ;;
    starttls|plain) scheme="smtp" ;;
  esac
  {
    printf 'url = "%s://%s:%s"\n' "$scheme" "$host" "$port"
    printf 'mail-from = "%s"\n' "$sender"
    printf 'mail-rcpt = "%s"\n' "$recipient"
    printf 'upload-file = "%s"\n' "$message"
    printf 'connect-timeout = 10\nmax-time = 30\nfail\nshow-error\nsilent\n'
    [[ "${mode,,}" == "starttls" ]] && printf 'ssl-reqd\n'
    if [[ -n "$username" ]]; then
      printf 'user = "%s:%s"\n' "$username" "$(cat "$password_file")"
    fi
  } >"$config"
  {
    printf 'From: %s\r\n' "$sender"
    printf 'To: %s\r\n' "$recipient"
    printf 'Subject: ResourcePortal SMTP validation\r\n'
    printf '\r\nResourcePortal Production Installer SMTP validation.\r\n'
  } >"$message"
  curl --config "$config" >/dev/null
  rm -f "$config" "$message"
  trap - RETURN
}
