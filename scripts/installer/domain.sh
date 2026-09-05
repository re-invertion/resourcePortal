#!/usr/bin/env bash

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
  local domain="$1"
  getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u
}

rp_validate_domain_dns() {
  local domain="$1" expected_addresses="$2" resolved
  resolved="$(rp_resolve_domain_addresses "$domain")"
  rp_dns_matches_addresses "$expected_addresses" "$resolved"
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
