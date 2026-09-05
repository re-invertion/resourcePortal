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
contains "$enrollment_source" 'rp_mount_runtime_namespace volumes nfs' 'worker mounts shared volume namespace over NFS'
contains "$enrollment_source" 'rp_configure_ufw' 'node firewall is configured from redeemed cluster CIDR'
not_contains "$enrollment_source" 'docker swarm join-token -q >' 'join tokens are never written by an unprotected shell redirection'

issue_source="$(cat "$repo_root/packages/resourceportal-api/scripts/issue-installer-enrollment.ts")"
contains "$issue_source" 'InstallerEnrollmentService' 'issuer reuses atomic enrollment service'
contains "$issue_source" 'INSTALLER_ENROLLMENT_OUTPUT_FILE' 'issuer writes machine-readable token output'
not_contains "$issue_source" 'console.log(issued.token' 'issuer never logs enrollment token'

runner_source="$(cat "$repo_root/packages/resourceportal-api/src/internal/installer-enrollment.runner.ts")"
contains "$runner_source" 'InstallerEnrollmentModule' 'dedicated HTTPS runner uses isolated enrollment module'
not_contains "$(cat "$repo_root/packages/resourceportal-api/src/app.module.ts")" 'InstallerEnrollmentModule' 'public AppModule does not expose enrollment route'

if (( failures>0 )); then printf '%s test(s) failed\n' "$failures" >&2; exit 1; fi
printf 'All installer enrollment tests passed.\n'
