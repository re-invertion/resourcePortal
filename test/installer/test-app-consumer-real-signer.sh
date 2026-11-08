#!/usr/bin/env bash
# Actual production Docker inline Node signer must receive its heredoc via stdin.
# Mocking the callback alone hides a missing docker run --interactive flag.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$root/scripts/installer/app-consumer-actions.sh"
tmp="$(umask 077; mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
key='test-only-real-hmac-key-of-at-least-32-bytes'
printf '%s' "$key" >"$tmp/key"
printf '%s' '{"function":"function/preaccesstoken","user":{"id":"invalid-probe-id"},"application":{"client_id":"rp-nonexistent-probe"}}' >"$tmp/body"
export RP_CFG_API_IMAGE="ghcr.io/re-invertion/resourceportal-api@sha256:$(printf 'a%.0s' {1..64})"
called=0
# The exact production command is intercepted only at the Docker boundary.
# Node executes the real production inline program.
docker() {
  [[ "$1" == run ]] || { echo 'unexpected Docker action' >&2; return 1; }
  shift
  local interactive=false no_network=false no_writes=false no_caps=false no_priv=false
  local node_entry=false image=false mounted=false arg prev=""
  for arg in "$@"; do
    [[ "$arg" != *"$key"* && "$arg" != *test-only-management-pat* ]] || return 1
    [[ "$arg" == "-i" || "$arg" == "--interactive" ]] && interactive=true
    [[ "$arg" == none && "$prev" == "--network" ]] && no_network=true
    [[ "$arg" == "--read-only" ]] && no_writes=true
    [[ "$arg" == ALL && "$prev" == "--cap-drop" ]] && no_caps=true
    [[ "$arg" == no-new-privileges && "$prev" == "--security-opt" ]] && no_priv=true
    [[ "$arg" == node && "$prev" == "--entrypoint" ]] && node_entry=true
    [[ "$arg" == "$RP_CFG_API_IMAGE" ]] && image=true
    [[ "$arg" == "type=bind,src=$tmp,dst=/rp-action-probe,readonly" ]] && mounted=true
    prev="$arg"
  done
  [[ "$no_network" == true && "$no_writes" == true &&
     "$no_caps" == true && "$no_priv" == true &&
     "$node_entry" == true && "$image" == true && "$mounted" == true ]] ||
    { echo 'Docker signer lost security isolation/digest pin' >&2; return 1; }
  ((called+=1))
  # Emulate documented Docker behavior: without -i, stdin is not forwarded.
  [[ "$interactive" == true ]] || return 0
  node - "$tmp/key" "$tmp/body"
}
rp_app_action_sign_probe "$tmp"
[[ "$called" == 1 && -s "$tmp/conf" ]] || {
  echo 'FAIL: real Node signing script was not forwarded to Docker stdin' >&2
  exit 1
}
node - "$tmp/key" "$tmp/body" "$tmp/conf" <<'NODE'
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHmac } = require('node:crypto');
const [keyFile, bodyFile, confFile] = process.argv.slice(2);
const key = readFileSync(keyFile);
const body = readFileSync(bodyFile);
const line = readFileSync(confFile, 'utf8');
const match = /^header = "ZITADEL-Signature: t=(\d{10}),v1=([a-f0-9]{64})"\n$/.exec(line);
assert.ok(match, 'curl config must contain exact HMAC signature header');
const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(match[1]));
assert.ok(skew <= 15, 'signature timestamp must be fresh');
const expected = createHmac('sha256', key).update(match[1] + '.').update(body).digest('hex');
assert.equal(match[2], expected, 'HMAC SHA256 must sign timestamp + dot + exact request bytes');
const tampered = Buffer.from(body);
tampered[0] ^= 1;
assert.notEqual(
  createHmac('sha256', key).update(match[1] + '.').update(tampered).digest('hex'),
  match[2],
  'tampered payload cannot retain the same signature'
);
NODE
echo 'PASS: real Docker Node signer receives heredoc via -i and signs exact bytes'
