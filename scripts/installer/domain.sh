#!/usr/bin/env bash

rp_ipv4_address_valid() {
  local value="$1" a b c d octet
  IFS=. read -r a b c d <<<"$value"
  [[ -n "$a" && -n "$b" && -n "$c" && -n "$d" ]] || return 1
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]+$ ]] || return 1
    (( 10#$octet >= 0 && 10#$octet <= 255 )) || return 1
  done
  [[ "$value" != *.*.*.*.* ]]
}

rp_detect_public_ipv4() {
  local endpoint response
  for endpoint in 'https://api.ipify.org' 'https://ipv4.icanhazip.com'; do
    response=''
    if command -v curl >/dev/null 2>&1; then
      response="$(curl -4fsS --connect-timeout 3 --max-time 5 "$endpoint" 2>/dev/null || true)"
    elif command -v wget >/dev/null 2>&1; then
      response="$(wget -4 -qO- --timeout=5 "$endpoint" 2>/dev/null || true)"
    else
      return 1
    fi
    response="${response//$'\r'/}"
    response="${response//$'\n'/}"
    if rp_ipv4_address_valid "$response"; then
      printf '%s\n' "$response"
      return 0
    fi
  done
  return 1
}
rp_dns_matches_addresses() {
  local expected_csv="$1" resolved="$2" expected resolved_ip
  [[ -n "$expected_csv" && -n "$resolved" ]] || return 1
  IFS=',' read -ra expected_items <<<"$expected_csv"
  while IFS= read -r resolved_ip; do
    [[ -n "$resolved_ip" ]] || continue
    for expected in "${expected_items[@]}"; do
      expected="${expected//[[:space:]]/}"
      [[ "$resolved_ip" == "$expected" ]] && return 0
    done
  done <<<"$resolved"
  return 1
}

rp_resolve_domain_addresses() {
  local domain="$1" resolver
  local resolvers="${RP_DNS_PUBLIC_RESOLVERS:-1.1.1.1 8.8.8.8}"
  command -v dig >/dev/null 2>&1 || return 1
  for resolver in $resolvers; do
    dig +time=3 +tries=1 +short A "$domain" "@$resolver" 2>/dev/null || true
  done | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print}' | sort -u
}

rp_validate_domain_dns() {
  local domain="$1" expected_addresses="$2" resolved
  resolved="$(rp_resolve_domain_addresses "$domain")"
  rp_dns_matches_addresses "$expected_addresses" "$resolved"
}

rp_dns_ui_status() {
  local domain="$1" expected_addresses="$2" resolved="$3" compact
  compact="${resolved//$'\n'/,}"
  if [[ -z "$resolved" ]]; then
    printf '%s: missing\n' "$domain"
  elif rp_dns_matches_addresses "$expected_addresses" "$resolved"; then
    printf '%s: %s\n' "$domain" "$compact"
  else
    printf '%s: %s (wrong)\n' "$domain" "$compact"
  fi
}

rp_wait_for_required_dns() {
  local app_domain="$1" auth_domain="$2" expected_addresses="$3" interval="${4:-10}"
  local app_resolved auth_resolved blocked=false app_status auth_status
  [[ -n "$app_domain" && -n "$auth_domain" && -n "$expected_addresses" ]] || return 1

  printf 'Required DNS records before ingress:\n'
  printf '  A  %s  %s\n' "$app_domain" "$expected_addresses"
  printf '  A  %s  %s\n' "$auth_domain" "$expected_addresses"
  printf 'Waiting for DNS propagation. Installation will not continue until both records are correct.\n'

  while true; do
    app_resolved="$(rp_resolve_domain_addresses "$app_domain")"
    auth_resolved="$(rp_resolve_domain_addresses "$auth_domain")"
    app_status="$(rp_dns_ui_status "$app_domain" "$expected_addresses" "$app_resolved")"
    auth_status="$(rp_dns_ui_status "$auth_domain" "$expected_addresses" "$auth_resolved")"
    if declare -F rp_ui_event >/dev/null; then
      rp_ui_event operation_updated dns "$app_status" || true
      rp_ui_event operation_updated dns "$auth_status" || true
    fi

    if rp_dns_matches_addresses "$expected_addresses" "$app_resolved" && \
       rp_dns_matches_addresses "$expected_addresses" "$auth_resolved"; then
      if [[ "$blocked" == true ]] && declare -F rp_ui_event >/dev/null; then
        rp_ui_event phase_unblocked dns 'Required DNS records are ready' || true
      fi
      printf 'DNS ready: %s and %s resolve to the configured ingress address.\n' "$app_domain" "$auth_domain"
      return 0
    fi

    if [[ "$blocked" != true ]]; then
      blocked=true
      if declare -F rp_ui_event >/dev/null; then
        rp_ui_event phase_blocked dns 'Waiting for required DNS A records' || true
      fi
    fi
    printf 'DNS not ready yet:\n'
    printf '  %s -> %s (expected: %s)\n' "$app_domain" "${app_resolved:-no record}" "$expected_addresses"
    printf '  %s -> %s (expected: %s)\n' "$auth_domain" "${auth_resolved:-no record}" "$expected_addresses"
    sleep "$interval"
  done
}

rp_validate_https_origin() {
  local domain="$1"
  curl --fail --silent --show-error \
    --proto '=https' \
    --tlsv1.2 \
    --connect-timeout 10 \
    --max-time 20 \
    "https://${domain}/api/health/live" >/dev/null
}

rp_wait_for_https_origin() {
  local domain="$1" timeout="${2:-300}" elapsed=0
  while (( elapsed < timeout )); do
    if rp_validate_https_origin "$domain"; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  printf 'HTTPS readiness failed for %s after %ss.\n' "$domain" "$timeout" >&2
  return 1
}


rp_validate_https_certificate() {
  local domain="$1" code
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --proto '=https' --tlsv1.2 --connect-timeout 10 --max-time 20 "https://${domain}/" 2>/dev/null)" || return 1
  [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
}

rp_wait_for_https_certificate() {
  local domain="$1" timeout="${2:-300}" elapsed=0
  while (( elapsed < timeout )); do
    rp_validate_https_certificate "$domain" && return 0
    sleep 5; elapsed=$((elapsed+5))
  done
  printf 'HTTPS certificate readiness failed for %s after %ss. Check Traefik/ACME logs for the certificate issuance error.\n' "$domain" "$timeout" >&2
  return 1
}
