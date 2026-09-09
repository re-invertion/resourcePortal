#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/docker.sh"
source "$repo_root/scripts/installer/firewall.sh"
source "$repo_root/scripts/installer/swarm.sh"

failures=0
assert_eq() {
  local expected="$1" actual="$2" name="$3"
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$name" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    printf 'FAIL: %s\nmissing: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" name="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf 'FAIL: %s\nunexpected: %s\n' "$name" "$needle" >&2
    failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_before() {
  local text="$1" first="$2" second="$3" name="$4"
  local a b
  a="$(grep -nF -- "$first" <<<"$text" | head -n1 | cut -d: -f1 || true)"
  b="$(grep -nF -- "$second" <<<"$text" | head -n1 | cut -d: -f1 || true)"
  if [[ -z "$a" || -z "$b" || "$a" -ge "$b" ]]; then
    printf 'FAIL: %s\n' "$name" >&2; failures=$((failures + 1))
  else printf 'PASS: %s\n' "$name"; fi
}
assert_status() {
  local expected="$1" name="$2"; shift 2
  set +e; "$@" >/tmp/rp-runtime.out 2>/tmp/rp-runtime.err; local actual=$?; set -e
  assert_eq "$expected" "$actual" "$name"
}

assert_status 0 "Docker equal minimum" rp_docker_version_supported 29.0.0 29.0.0
assert_status 0 "Docker newer than minimum" rp_docker_version_supported 29.1.3 29.0.0
assert_status 1 "Docker older than minimum" rp_docker_version_supported 28.5.1 29.0.0

rules="$(rp_render_ufw_rules 2222 10.20.0.0/24 true 7443)"
assert_contains "$rules" 'allow 2222/tcp comment ResourcePortal-SSH' "preserve SSH port"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 2377 proto tcp' "restrict Swarm manager port"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 7946 proto tcp' "allow Swarm gossip tcp"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 7946 proto udp' "allow Swarm gossip udp"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 4789 proto udp' "allow Swarm overlay"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 2049 proto tcp' "restrict NFSv4"
assert_contains "$rules" 'allow from 10.20.0.0/24 to any port 7443 proto tcp comment ResourcePortal-Enrollment' "restrict enrollment listener"
assert_contains "$rules" 'allow 80/tcp comment ResourcePortal-HTTP' "public HTTP ingress"
assert_contains "$rules" 'allow 443/tcp comment ResourcePortal-HTTPS' "public HTTPS ingress"
assert_before "$rules" 'allow 2222/tcp comment ResourcePortal-SSH' 'allow 80/tcp comment ResourcePortal-HTTP' "SSH rule rendered before public ingress"

rules_no_ingress="$(rp_render_ufw_rules 22 10.20.0.0/24 false)"
if [[ "$rules_no_ingress" == *'allow 80/tcp'* || "$rules_no_ingress" == *'allow 443/tcp'* ]]; then
  printf 'FAIL: non-ingress node does not expose HTTP/HTTPS\n' >&2; failures=$((failures + 1))
else printf 'PASS: non-ingress node does not expose HTTP/HTTPS\n'; fi

assert_eq "healthy" "$(rp_manager_quorum_state 1 1)" "single manager is valid quorum"
assert_eq "recommend-3" "$(rp_manager_quorum_recommendation 1)" "single manager gets HA recommendation"
assert_eq "recommend-3" "$(rp_manager_quorum_recommendation 2)" "two managers not target HA"
assert_eq "ok" "$(rp_manager_quorum_recommendation 3)" "three managers accepted"
assert_eq "degraded" "$(rp_manager_quorum_state 3 1)" "lost manager majority is degraded"
assert_eq "healthy" "$(rp_manager_quorum_state 3 2)" "majority is healthy"

assert_status 0 "valid advertise IPv4" rp_validate_host_address 10.20.0.10 $'10.20.0.10\n127.0.0.1'
assert_status 1 "reject address not on host" rp_validate_host_address 10.20.0.99 $'10.20.0.10\n127.0.0.1'

route_text='default via 192.168.100.1 dev ens18 proto dhcp src 192.168.100.100 metric 100'
assert_eq "ens18" "$(rp_default_route_interface_text "$route_text")" "detect default-route interface"
assert_eq "192.168.100.100" "$(rp_default_route_address_text "$route_text")" "detect default-route IPv4"
assert_eq "192.168.100.0/24" "$(rp_ipv4_network_cidr 192.168.100.100/24)" "derive /24 network CIDR"
assert_eq "10.20.32.0/20" "$(rp_ipv4_network_cidr 10.20.47.15/20)" "derive non-octet network CIDR"
assert_status 1 "reject invalid IPv4 CIDR" rp_ipv4_network_cidr 192.168.100.100/33

swarm_source="$(cat "$repo_root/scripts/installer/swarm.sh")"
assert_contains "$swarm_source" 'docker swarm init --advertise-addr "$advertise_addr" --data-path-addr "$data_path_addr" >/dev/null' 'Swarm init suppresses join-token stdout'

ufw_log="$(mktemp /tmp/rp-ufw-cleanup.XXXXXX)"
: >"$ufw_log"
ufw() {
  if [[ "$1 $2" == 'status numbered' ]]; then
    cat <<'RULES'
[ 1] 22/tcp ALLOW IN Anywhere # ResourcePortal-SSH
[ 2] 80/tcp ALLOW IN Anywhere # ResourcePortal-HTTP
[ 3] 2222/tcp ALLOW IN Anywhere # Unrelated-SSH
RULES
    return 0
  fi
  printf '%s\n' "$*" >>"$ufw_log"
}
rp_remove_resourceportal_ufw_rules
unset -f ufw
ufw_cleanup="$(cat "$ufw_log")"
assert_contains "$ufw_cleanup" '--force delete 2' 'UFW cleanup deletes RP rule in descending order'
assert_contains "$ufw_cleanup" '--force delete 1' 'UFW cleanup deletes second RP rule'
assert_not_contains "$ufw_cleanup" 'delete 3' 'UFW cleanup preserves unrelated rule'
assert_not_contains "$ufw_cleanup" 'reset' 'UFW cleanup never performs global reset'
rm -f "$ufw_log"

assert_status 0 'known versioned RP secret accepted' rp_swarm_resourceportal_secret_name rp_cookie_secret_deadbeef
assert_status 0 'legacy ZITADEL masterkey secret accepted' rp_swarm_resourceportal_secret_name zitadel_masterkey
assert_status 1 'unrelated secret rejected by RP classifier' rp_swarm_resourceportal_secret_name other_secret

test_swarm_unrelated_classification() (
  RP_CFG_STACK_NAME=resourceportal-control-plane
  export RP_CFG_STACK_NAME
  docker() {
    case "$1 $2" in
      'info --format') printf 'active\n' ;;
      'service ls') printf '%s\n' resourceportal-control-plane_api resourceportal-control-plane_web other_stack_web ;;
      'secret ls') printf '%s\n' rp_postgres_password rp_cookie_secret_deadbeef other_secret ;;
      'config ls') printf '%s\n' resourceportal-control-plane_postgres_fence_script other_config ;;
      *) return 1 ;;
    esac
  }
  rp_swarm_unrelated_resources
)
unrelated_out="$(test_swarm_unrelated_classification)"
assert_contains "$unrelated_out" 'service other_stack_web' 'Swarm classifier reports unrelated service'
assert_contains "$unrelated_out" 'secret other_secret' 'Swarm classifier reports unrelated secret'
assert_contains "$unrelated_out" 'config other_config' 'Swarm classifier reports unrelated config'

test_swarm_only_resourceportal() (
  RP_CFG_STACK_NAME=resourceportal-control-plane
  export RP_CFG_STACK_NAME
  docker() {
    case "$1 $2" in
      'info --format') printf 'active\n' ;;
      'service ls') printf '%s\n' resourceportal-control-plane_api resourceportal-control-plane_web resourceportal-control-plane-installer-enrollment rp-storage-runtime-probe-deadbeef ;;
      'secret ls') printf '%s\n' rp_postgres_password rp_cookie_secret_deadbeef installer_enrollment_tls_cert_deadbeef ;;
      'config ls') printf '%s\n' resourceportal-control-plane_postgres_fence_script resourceportal-control-plane_zitadel_public_config ;;
      *) return 1 ;;
    esac
  }
  rp_swarm_unrelated_resources
)
assert_eq '' "$(test_swarm_only_resourceportal)" 'Swarm classifier accepts only ResourcePortal resources'

if (( failures > 0 )); then printf '%s\n' "$failures test(s) failed" >&2; exit 1; fi
printf 'All installer host runtime tests passed.\n'
