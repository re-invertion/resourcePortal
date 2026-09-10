#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/installer/common.sh"
source "$repo_root/scripts/installer/enrollment.sh"
failures=0
pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1" >&2; failures=$((failures+1)); }
status(){ local e="$1" n="$2"; shift 2; set +e; "$@" >/tmp/rp-enroll.out 2>/tmp/rp-enroll.err; local a=$?; set -e; [[ "$a" == "$e" ]] && pass "$n" || fail "$n"; }
contains(){ [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3"; }
not_contains(){ [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3"; }

status 0 'worker role accepted' rp_validate_enrollment_role worker
status 0 'manager role accepted' rp_validate_enrollment_role manager
status 1 'edited admin role rejected' rp_validate_enrollment_role admin

issue_cli_test() (
  RP_CFG_SWARM_ADVERTISE_ADDR=10.20.0.10
  RP_CFG_API_IMAGE=example.invalid/api@sha256:deadbeef
  export RP_CFG_SWARM_ADVERTISE_ADDR RP_CFG_API_IMAGE
  rp_spki_pin(){ printf 'sha256//test-pin\n'; }
  rp_issue_enrollment_bundle(){
    [[ "$1" == manager ]] || return 1
    [[ "$2" == /tmp/test-manager.bundle ]] || return 1
    [[ "$3" == https://10.20.0.10:7443 ]] || return 1
    [[ "$4" == sha256//test-pin ]] || return 1
  }
  RP_ENROLLMENT_CERT_PATH=/tmp/fake-enrollment.crt
  export RP_ENROLLMENT_CERT_PATH
  : >"$RP_ENROLLMENT_CERT_PATH"
  rp_issue_node_bundle_cli manager /tmp/test-manager.bundle
)
status 0 'issue-bundle CLI derives pinned enrollment endpoint from Primary config' issue_cli_test

test_enrollment_output_dir_owned_by_api_node() (
  local root marker
  root="$(mktemp -d /tmp/rp-enrollment-output.XXXXXX)"
  marker="$root/chown"
  docker() {
    [[ "$1" == run ]] || return 1
    printf '1001:1002\n'
  }
  chown() { printf '%s\n' "$*" >"$marker"; }
  rp_prepare_enrollment_output_dir "$root/output" 'example.invalid/api@sha256:deadbeef' || return 1
  [[ "$(cat "$marker")" == "1001:1002 $root/output" ]] || return 1
  [[ "$(stat -c '%a' "$root/output")" == 700 ]]
)
status 0 'enrollment issuer output directory is writable by API node user' test_enrollment_output_dir_owned_by_api_node

bundle="$(mktemp /tmp/rp-join-bundle.XXXXXX)"
rp_write_join_bundle "$bundle" worker 'enrollment-token-abc_1234567890123456789012345678901234567890' '2026-09-05T16:30:00.000Z' 'https://10.0.0.10:7443' 'sha256//pin-value'
text="$(cat "$bundle")"
contains "$text" 'RP_ENROLLMENT_ROLE=worker' 'bundle is role-bound'
contains "$text" 'RP_ENROLLMENT_TOKEN=enrollment-token-' 'bundle carries enrollment token'
contains "$text" 'RP_ENROLLMENT_PIN=sha256//pin-value' 'bundle carries SPKI pin'
not_contains "$text" 'SWMTKN-' 'bundle never carries raw Swarm join token'
[[ "$(stat -c '%a' "$bundle")" == '600' ]] && pass 'bundle permissions are 0600' || fail 'bundle permissions are 0600'
rm -f "$bundle"

enrollment_source="$(cat "$repo_root/scripts/installer/enrollment.sh")"
contains "$enrollment_source" '--pinnedpubkey' 'redemption pins enrollment SPKI'
contains "$enrollment_source" '--insecure' 'self-signed TLS is accepted only with explicit pin'
contains "$enrollment_source" '/installer/enrollment/redeem' 'redemption uses dedicated enrollment endpoint'
contains "$enrollment_source" '/installer/enrollment/complete' 'joined node calls completion endpoint'
contains "$enrollment_source" '/var/run/docker.sock' 'enrollment listener can inspect and label joined Swarm nodes'
contains "$enrollment_source" '--group-add "$docker_socket_gid"' 'enrollment listener gets Docker socket supplemental group'

docker_socket_gid_test() (
  socket_file="$(mktemp /tmp/rp-docker-socket.XXXXXX)"
  stat(){ [[ "$1 $2" == '-c %g' ]] || return 1; printf '989\n'; }
  [[ "$(rp_docker_socket_group_gid "$socket_file")" == 989 ]]
)
status 0 'Docker socket group helper returns numeric socket GID' docker_socket_gid_test
contains "$enrollment_source" 'rp_mount_runtime_namespace nfs volumes' 'worker mounts shared volume namespace over NFS'
contains "$enrollment_source" 'rp_join_swarm_for_enrollment' 'add-node uses resumable Swarm join helper'

resume_join_test() (
  calls="$(mktemp /tmp/rp-enrollment-join-calls.XXXXXX)"
  docker() {
    if [[ "$1 $2 $3" == "info --format {{.Swarm.LocalNodeState}}" ]]; then printf 'active\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.Cluster.ID}}" ]]; then printf 'cluster-123\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.ControlAvailable}}" ]]; then printf 'true\n'; return 0; fi
    printf '%s\n' "$*" >>"$calls"
    return 0
  }
  rp_join_swarm_for_enrollment manager secret-token 10.20.0.10:2377 cluster-123 || return 1
  [[ ! -s "$calls" ]]
)
status 0 'add-node resumes manager already joined to expected cluster without rejoining' resume_join_test

wrong_cluster_test() (
  docker() {
    if [[ "$1 $2 $3" == "info --format {{.Swarm.LocalNodeState}}" ]]; then printf 'active\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.Cluster.ID}}" ]]; then printf 'other-cluster\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.ControlAvailable}}" ]]; then printf 'true\n'; return 0; fi
    return 0
  }
  rp_join_swarm_for_enrollment manager secret-token 10.20.0.10:2377 cluster-123
)
status 1 'add-node refuses resume when host belongs to another Swarm cluster' wrong_cluster_test

wrong_role_test() (
  docker() {
    if [[ "$1 $2 $3" == "info --format {{.Swarm.LocalNodeState}}" ]]; then printf 'active\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.Cluster.ID}}" ]]; then printf 'cluster-123\n'; return 0; fi
    if [[ "$1 $2 $3" == "info --format {{.Swarm.ControlAvailable}}" ]]; then printf 'false\n'; return 0; fi
    return 0
  }
  rp_join_swarm_for_enrollment manager secret-token 10.20.0.10:2377 cluster-123
)
status 1 'add-node refuses manager resume when local node is only a worker' wrong_role_test


enrollment_failure_clears_return_trap_test() (
  bundle="$(mktemp /tmp/rp-enrollment-trap-bundle.XXXXXX)"
  rp_write_join_bundle "$bundle" manager 'enrollment-token-abc_1234567890123456789012345678901234567890' '2026-09-10T12:00:00Z' 'https://10.20.0.10:7443' 'sha256//pin-value'
  curl(){ printf '%s\n' '{"role":"manager","joinToken":"secret","managerEndpoint":"10.20.0.10:2377","nfsServerAddress":"10.20.0.10","clusterId":"cluster-123","clusterCidr":"10.20.0.0/24"}'; }
  jq(){
    case "$2" in
      .role) printf 'manager\n' ;;
      .joinToken) printf 'secret\n' ;;
      .managerEndpoint) printf '10.20.0.10:2377\n' ;;
      .nfsServerAddress) printf '10.20.0.10\n' ;;
      .clusterId) printf 'cluster-123\n' ;;
      .clusterCidr) printf '10.20.0.0/24\n' ;;
      *) return 1 ;;
    esac
  }
  rp_detect_ssh_port(){ printf '22\n'; }
  rp_configure_ufw(){ return 0; }
  rp_join_swarm_for_enrollment(){ return 0; }
  rp_mount_runtime_namespace(){ return 1; }
  set +e
  rp_redeem_join_bundle "$bundle"
  rc=$?
  set -e
  [[ $rc -eq 1 ]] || return 1
  [[ -z "$(trap -p RETURN)" ]]
)
status 0 'failed add-node enrollment does not leak RETURN cleanup trap into caller' enrollment_failure_clears_return_trap_test
contains "$enrollment_source" 'rp_configure_ufw' 'node firewall is configured from redeemed cluster CIDR'
issue_function="$(sed -n '/rp_issue_enrollment_bundle()/,/^}/p' "$repo_root/scripts/installer/enrollment.sh")"
contains "$issue_function" '--detach' 'enrollment issuer one-shot service is created detached'
not_contains "$enrollment_source" 'docker swarm join-token -q >' 'join tokens are never written by an unprotected shell redirection'
control_network_refs="$(grep -c -- '--network "$control_network"' <<<"$enrollment_source" || true)"
[[ "$control_network_refs" -ge 2 ]] && pass 'enrollment listener and issuer join RP control network' || fail 'enrollment listener and issuer join RP control network'

issue_source="$(cat "$repo_root/packages/resourceportal-api/scripts/issue-installer-enrollment.ts")"
contains "$issue_source" 'InstallerEnrollmentService' 'issuer reuses atomic enrollment service'
contains "$issue_source" 'INSTALLER_ENROLLMENT_OUTPUT_FILE' 'issuer writes machine-readable token output'
not_contains "$issue_source" 'console.log(issued.token' 'issuer never logs enrollment token'

runner_source="$(cat "$repo_root/packages/resourceportal-api/src/internal/installer-enrollment.runner.ts")"
contains "$runner_source" 'InstallerEnrollmentModule' 'dedicated HTTPS runner uses isolated enrollment module'
not_contains "$(cat "$repo_root/packages/resourceportal-api/src/app.module.ts")" 'InstallerEnrollmentModule' 'public AppModule does not expose enrollment route'

reconfigure_source="$(cat "$repo_root/scripts/installer/reconfigure.sh")"
contains "$reconfigure_source" 'rp_mount_runtime_namespace nfs volumes "$new_storage"' 'address migration remounts volumes with mode-first argument order'
contains "$reconfigure_source" 'rp_mount_runtime_namespace nfs secrets "$new_storage"' 'address migration remounts secrets with mode-first argument order'
contains "$reconfigure_source" 'rp_mount_runtime_namespace nfs platform "$new_storage"' 'address migration remounts platform with mode-first argument order'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer enrollment tests passed.\n'
