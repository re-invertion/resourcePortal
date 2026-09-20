#!/usr/bin/env bash

rp_acme_environment_valid() {
  case "$1" in
    production|staging) return 0 ;;
    *) return 1 ;;
  esac
}

rp_acme_resolver_for_state() {
  local state="$1" environment="${RP_CFG_ACME_ENVIRONMENT:-production}"
  rp_acme_environment_valid "$environment" || return 1
  case "$state" in
    bootstrap|ingress) printf 'letsencrypt-staging\n' ;;
    final)
      if [[ "$environment" == staging ]]; then printf 'letsencrypt-staging\n'; else printf 'letsencrypt\n'; fi
      ;;
    *) return 1 ;;
  esac
}

rp_acme_ca_server_for_environment() {
  case "$1" in
    production) printf '%s\n' "${RP_ACME_PRODUCTION_CA_SERVER:-https://acme-v02.api.letsencrypt.org/directory}" ;;
    staging) printf '%s\n' "${RP_ACME_STAGING_CA_SERVER:-https://acme-staging-v02.api.letsencrypt.org/directory}" ;;
    *) return 1 ;;
  esac
}

rp_acme_storage_file() {
  local environment="$1" base="${RP_ACME_PLATFORM_DIR:-/mnt/resourceportal/platform/traefik}"
  case "$environment" in
    production) printf '%s/acme.json\n' "$base" ;;
    staging) printf '%s/acme-staging.json\n' "$base" ;;
    *) return 1 ;;
  esac
}

rp_acme_storage_has_domain() {
  local path="$1" resolver="$2" domain="$3"
  [[ -s "$path" ]] || return 1
  jq -e --arg resolver "$resolver" --arg domain "$domain" '
    ((.[$resolver].Certificates // []) | any(.[];
      (.domain.main == $domain) or (((.domain.sans // []) | index($domain)) != null)
    )) == true
  ' "$path" >/dev/null 2>&1 || return 1
}

rp_acme_production_state_reusable() {
  local path="$1"; shift
  local certificate_json cert_b64 tmp domain
  local min_validity="${RP_ACME_REUSE_MIN_VALIDITY_SECONDS:-86400}" covers
  [[ -s "$path" && "$#" -gt 0 ]] || return 1

  while IFS= read -r certificate_json; do
    [[ -n "$certificate_json" ]] || continue
    covers=true
    for domain in "$@"; do
      if ! jq -e --arg domain "$domain" \
        '(.domain.main == $domain) or (((.domain.sans // []) | index($domain)) != null)' \
        <<<"$certificate_json" >/dev/null 2>&1; then
        covers=false
        break
      fi
    done
    [[ "$covers" == true ]] || continue

    cert_b64="$(jq -er '.certificate // empty' <<<"$certificate_json" 2>/dev/null)" || continue
    [[ -n "$cert_b64" ]] || continue
    tmp="$(mktemp /tmp/resourceportal-acme-cert.XXXXXX)" || return 1
    chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
    if ! printf '%s' "$cert_b64" | base64 --decode >"$tmp" 2>/dev/null; then
      rm -f "$tmp"
      continue
    fi
    if ! openssl x509 -in "$tmp" -noout -checkend "$min_validity" >/dev/null 2>&1; then
      rm -f "$tmp"
      continue
    fi
    covers=true
    for domain in "$@"; do
      if ! openssl x509 -in "$tmp" -noout -checkhost "$domain" >/dev/null 2>&1; then
        covers=false
        break
      fi
    done
    rm -f "$tmp"
    [[ "$covers" == true ]] && return 0
  done < <(jq -c '.letsencrypt.Certificates[]?' "$path" 2>/dev/null || true)
  return 1
}

rp_acme_restore_cached_state() {
  local platform_dir="${RP_ACME_PLATFORM_DIR:-/mnt/resourceportal/platform/traefik}"
  local cache_dir="${RP_ACME_CACHE_DIR:-/var/lib/resourceportal/acme-cache}"
  local active="$platform_dir/acme.json" cached="$cache_dir/acme.json" tmp

  install -d -m 0700 "$platform_dir" "$cache_dir" || return 1
  [[ -s "$active" ]] && return 0
  [[ -s "$cached" ]] || return 0

  if ! jq -e 'type == "object" and (.letsencrypt | type == "object")' "$cached" >/dev/null 2>&1; then
    # Corrupt cache must never block a clean issuance. Quarantine it without
    # printing certificate/account material.
    mv -f "$cached" "$cache_dir/acme.json.invalid.$(date +%s)" 2>/dev/null || rm -f "$cached"
    return 0
  fi

  tmp="$active.restore.$$"
  cp -- "$cached" "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$active"
}

rp_acme_cache_active_state() {
  local platform_dir="${RP_ACME_PLATFORM_DIR:-/mnt/resourceportal/platform/traefik}"
  local cache_dir="${RP_ACME_CACHE_DIR:-/var/lib/resourceportal/acme-cache}"
  local active="$platform_dir/acme.json" target="$cache_dir/acme.json" tmp

  [[ -s "$active" ]] || return 1
  jq -e 'type == "object" and (.letsencrypt | type == "object")' "$active" >/dev/null 2>&1 || return 1
  install -d -m 0700 "$cache_dir" || return 1
  chmod 0700 "$cache_dir" || return 1
  tmp="$target.tmp.$$"
  cp -- "$active" "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$target"
}

rp_acme_prepare_state() {
  local platform_dir="${RP_ACME_PLATFORM_DIR:-/mnt/resourceportal/platform/traefik}"
  local cache_dir="${RP_ACME_CACHE_DIR:-/var/lib/resourceportal/acme-cache}"
  install -d -m 0700 "$platform_dir" "$cache_dir" || return 1
  rp_acme_restore_cached_state
}

rp_prepare_oidc_staging_ca() {
  local domain="$1" tmpdir count leaf last issuer_url root subject issuer intermediates
  [[ "${RP_CFG_ACME_ENVIRONMENT:-production}" == staging ]] || {
    unset RP_CFG_OIDC_EXTRA_CA_B64
    return 0
  }
  [[ -n "$domain" && "$domain" != *[[:space:]]* ]] || return 1
  tmpdir="$(mktemp -d /tmp/resourceportal-oidc-staging-ca.XXXXXX)" || return 1
  chmod 0700 "$tmpdir" || { rm -rf "$tmpdir"; return 1; }
  trap 'rm -rf "${tmpdir:-}"; trap - RETURN' RETURN

  if ! openssl s_client -showcerts -servername "$domain" -connect 127.0.0.1:443 </dev/null 2>/dev/null \
      | awk -v dir="$tmpdir" '
          /-----BEGIN CERTIFICATE-----/ { n++; f=sprintf("%s/cert-%02d.pem", dir, n) }
          f { print >f }
          /-----END CERTIFICATE-----/ { close(f); f="" }
        '; then
    return 1
  fi

  count="$(find "$tmpdir" -maxdepth 1 -type f -name 'cert-*.pem' | wc -l | tr -d ' ')" || return 1
  [[ "$count" =~ ^[0-9]+$ && "$count" -ge 2 ]] || return 1
  leaf="$tmpdir/cert-01.pem"
  last="$(find "$tmpdir" -maxdepth 1 -type f -name 'cert-*.pem' | sort | tail -n1)"
  openssl x509 -in "$leaf" -noout -checkhost "$domain" >/dev/null 2>&1 || return 1

  issuer_url="$(openssl x509 -in "$last" -noout -text 2>/dev/null \
    | sed -n '/Authority Information Access/,+8p' \
    | sed -n 's/.*CA Issuers - URI://p' \
    | head -n1)" || return 1
  case "$issuer_url" in http://*|https://*) ;; *) return 1 ;; esac

  curl -fsSL --connect-timeout 10 "$issuer_url" -o "$tmpdir/root.download" || return 1
  root="$tmpdir/root.pem"
  if ! openssl x509 -inform DER -in "$tmpdir/root.download" -out "$root" 2>/dev/null; then
    openssl x509 -in "$tmpdir/root.download" -out "$root" 2>/dev/null || return 1
  fi
  chmod 0600 "$root" || return 1

  subject="$(openssl x509 -in "$root" -noout -subject -nameopt RFC2253 2>/dev/null | sed 's/^subject=//')" || return 1
  issuer="$(openssl x509 -in "$root" -noout -issuer -nameopt RFC2253 2>/dev/null | sed 's/^issuer=//')" || return 1
  [[ -n "$subject" && "$subject" == "$issuer" ]] || return 1
  openssl x509 -in "$root" -noout -text 2>/dev/null \
    | grep -A1 'Basic Constraints' \
    | grep -q 'CA:TRUE' || return 1
  openssl verify -CAfile "$root" "$root" >/dev/null 2>&1 || return 1
  openssl verify -CAfile "$root" "$last" >/dev/null 2>&1 || return 1

  intermediates="$tmpdir/intermediates.pem"
  : >"$intermediates"
  find "$tmpdir" -maxdepth 1 -type f -name 'cert-*.pem' | sort | tail -n +2 | while IFS= read -r cert; do
    cat "$cert" >>"$intermediates"
  done
  openssl verify -CAfile "$root" -untrusted "$intermediates" "$leaf" >/dev/null 2>&1 || return 1

  RP_CFG_OIDC_EXTRA_CA_B64="$(openssl base64 -A -in "$root")" || return 1
  [[ -n "$RP_CFG_OIDC_EXTRA_CA_B64" ]] || return 1
  export RP_CFG_OIDC_EXTRA_CA_B64
  rm -rf "$tmpdir"
  trap - RETURN
}

rp_traefik_recent_logs() {
  local stack="${RP_CFG_STACK_NAME:-resourceportal-control-plane}"
  local service="${RP_CFG_TRAEFIK_SERVICE_NAME:-${stack}_traefik}"
  local lookback="${RP_ACME_LOG_LOOKBACK:-15m}" output='' cid log_path

  if command -v docker >/dev/null 2>&1; then
    output="$(docker service logs --raw --since "$lookback" "$service" 2>&1 || true)"
    if [[ -z "$output" ]]; then
      while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        output+="$(docker logs --since "$lookback" "$cid" 2>&1 || true)"$'\n'
      done < <(docker ps --filter "label=com.docker.swarm.service.name=$service" --format '{{.ID}}' 2>/dev/null || true)
    fi
    if [[ -z "${output//$'\n'/}" ]]; then
      while IFS= read -r cid; do
        [[ -n "$cid" ]] || continue
        log_path="$(docker inspect "$cid" --format '{{.LogPath}}' 2>/dev/null || true)"
        [[ -n "$log_path" && -r "$log_path" ]] || continue
        output+="$(tail -n "${RP_ACME_LOG_TAIL_LINES:-500}" "$log_path" 2>/dev/null || true)"$'\n'
      done < <(docker ps --filter "label=com.docker.swarm.service.name=$service" --format '{{.ID}}' 2>/dev/null || true)
    fi
  fi
  printf '%s' "$output"
}

rp_traefik_acme_error_for_domain() {
  local domain="$1" logs
  logs="$(rp_traefik_recent_logs)"
  [[ -n "$logs" ]] || return 1
  grep -F "$domain" <<<"$logs" | grep -Ei 'Unable to obtain ACME certificate|acme: error|rateLimited|rejectedIdentifier|unauthorized' | tail -n 1
}

rp_acme_classify_error() {
  local domain="$1" raw="$2" retry=''
  if [[ "$raw" == *'rateLimited'* || "$raw" == *'too many certificates'* ]]; then
    retry="$(sed -nE 's/.*retry after ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC).*/\1/p' <<<"$raw" | tail -n1)"
    if [[ -n "$retry" ]]; then
      printf 'ACME rate limit reached for %s. Retry after %s. A preserved ResourcePortal ACME cache will be reused automatically when available.\n' "$domain" "$retry"
    else
      printf 'ACME rate limit reached for %s. Check the Traefik ACME log for the retry-after time. A preserved ResourcePortal ACME cache will be reused automatically when available.\n' "$domain"
    fi
    return 0
  fi
  if [[ "$raw" == *'rejectedIdentifier'* ]]; then
    printf 'ACME rejected the identifier %s. Verify that the hostname is publicly valid and eligible for certificate issuance.\n' "$domain"
    return 0
  fi
  if [[ "$raw" == *'unauthorized'* ]]; then
    printf 'ACME HTTP-01 authorization failed for %s. Verify public DNS and inbound TCP/80 forwarding to this ingress node.\n' "$domain"
    return 0
  fi
  [[ -n "$raw" ]] || return 1
  printf 'ACME certificate issuance failed for %s. Inspect ResourcePortal diagnostics for the sanitized Traefik ACME error.\n' "$domain"
}

rp_acme_error_terminal() {
  local raw="$1"
  [[ "$raw" == *'rateLimited'* || "$raw" == *'too many certificates'* || "$raw" == *'rejectedIdentifier'* || "$raw" == *'unauthorized'* ]]
}

rp_wait_for_acme_certificate() {
  local domain="$1" environment="${2:-production}" timeout="${3:-300}"
  local interval="${RP_ACME_CHECK_INTERVAL_SECONDS:-5}" elapsed=0 raw='' summary='' path resolver
  rp_acme_environment_valid "$environment" || return 2
  path="$(rp_acme_storage_file "$environment")" || return 2
  if [[ "$environment" == staging ]]; then resolver='letsencrypt-staging'; else resolver='letsencrypt'; fi

  while (( elapsed < timeout )); do
    if [[ "$environment" == staging ]]; then
      if rp_acme_storage_has_domain "$path" "$resolver" "$domain"; then return 0; fi
    else
      if rp_validate_https_certificate "$domain"; then return 0; fi
    fi

    raw="$(rp_traefik_acme_error_for_domain "$domain" 2>/dev/null || true)"
    if [[ -n "$raw" ]] && rp_acme_error_terminal "$raw"; then
      summary="$(rp_acme_classify_error "$domain" "$raw")"
      printf '%s\n' "$summary" >&2
      return 1
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  raw="$(rp_traefik_acme_error_for_domain "$domain" 2>/dev/null || true)"
  if [[ -n "$raw" ]]; then
    summary="$(rp_acme_classify_error "$domain" "$raw" 2>/dev/null || true)"
    [[ -n "$summary" ]] && printf '%s\n' "$summary" >&2
  fi
  printf 'ACME %s certificate readiness failed for %s after %ss.\n' "$environment" "$domain" "$timeout" >&2
  return 1
}
