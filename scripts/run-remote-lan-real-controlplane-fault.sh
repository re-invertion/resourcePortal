#!/usr/bin/env bash
# STOP real RP API and churn a real Traefik proxy during disposable CI smoke ONLY.
set -euo pipefail
fail() { printf '[fault] FAIL: %s\n' "$*" >&2; exit 1; }
log() { printf '[fault] %s\n' "$*"; }
[ "$(printenv RP_LAN_REAL_CONTROL_PLANE_FAULT || true)" = 1 ] &&
[ "$(printenv GITHUB_ACTIONS || true)" = true ] &&
[ "$(printenv CI || true)" = true ] &&
[ "$(printenv GITHUB_REPOSITORY || true)" = re-invertion/resourcePortal ] &&
[[ "$(printenv GITHUB_RUN_ID || true)" =~ ^[0-9]+$ ]] &&
[ "$(printenv RUNNER_TEMP || true)" = /home/runner/work/_temp ] ||
  fail "Refusing to mutate any non-disposable runner"
[ "$#" -eq 4 ] || fail "Expected prepare, lease, outage and restore markers"
PREPARE="$1"; LEASE="$2"; OUTAGE="$3"; RESTORE="$4"
for path in "$PREPARE" "$LEASE" "$OUTAGE" "$RESTORE"; do
  [[ "$path" = /tmp/tmp.*/* && ! -L "$path" ]] || fail "Unsafe marker path"
done
[ "$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}')" = 'active true' ] ||
  fail "Not a real Swarm manager"
[ "$(docker node ls --format '{{.ID}}' | wc -l)" -eq 1 ] ||
  fail "Must be isolated single-node Swarm"
[ -f "$RUNNER_TEMP/resource-portal-api.pid" ] &&
[ -d "$GITHUB_WORKSPACE" ] || fail "Disposable Stage20 API missing"

SERVICE="rp-gate-fault-traefik-$GITHUB_RUN_ID"
CONFIG="rp-gate-fault-config-$GITHUB_RUN_ID"
FILE="$(mktemp "$RUNNER_TEMP/traefik-rp-fault.XXXXXXXX")"
SERVICE_CREATED=0; CONFIG_CREATED=0; API_STOPPED=0
api_ok() { curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; }
proxy_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18088/api/health 2>/dev/null || echo 000; }
wait_proxy() {
  for i in $(seq 1 100); do
    [ "$(proxy_code)" = "$1" ] && return 0
    sleep 1
  done
  return 1
}
restore_api() {
  if [ "$API_STOPPED" -eq 1 ] && ! api_ok; then
    (cd "$GITHUB_WORKSPACE"; nohup npm run api:start > "$RUNNER_TEMP/rp-api-restored.log" 2>&1 < /dev/null &
      echo "$!" > "$RUNNER_TEMP/resource-portal-api.pid")
    for i in $(seq 1 90); do
      api_ok && { API_STOPPED=0; return 0; }
      sleep 1
    done
    return 1
  fi
  API_STOPPED=0
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  restore_api
  if [ "$SERVICE_CREATED" -eq 1 ]; then
    docker service rm "$SERVICE" >/dev/null 2>&1 || status=1
    for i in $(seq 1 35); do
      ! docker service inspect "$SERVICE" >/dev/null 2>&1 && break
      sleep 1
    done
    docker service inspect "$SERVICE" >/dev/null 2>&1 && status=1
  fi
  if [ "$CONFIG_CREATED" -eq 1 ]; then
    for i in $(seq 1 35); do
      docker config rm "$CONFIG" >/dev/null 2>&1 && break
      sleep 1
    done
    docker config inspect "$CONFIG" >/dev/null 2>&1 && status=1
  fi
  rm -f -- "$FILE"
  api_ok || { log "FAIL: disposable API did not recover" >&2; exit 1; }
  [ "$status" -eq 0 ] || log "FAIL: fault or resource cleanup did not complete" >&2
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
api_ok || fail "API not healthy before test"
if ss -H -ltn '( sport = :18088 )' | grep -q LISTEN; then
  fail "Port 18088 already bound by another process"
fi
docker service inspect "$SERVICE" >/dev/null 2>&1 && fail "Existing service collision"
docker config inspect "$CONFIG" >/dev/null 2>&1 && fail "Existing config collision"
cat > "$FILE" <<'YAML'
http:
  routers:
    rp-api:
      entryPoints: [web]
      rule: 'PathPrefix("/api")'
      service: rp-api
  services:
    rp-api:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:3000"
YAML
# Mark for cleanup before running a potentially partially successful command.
CONFIG_CREATED=1
docker config create "$CONFIG" "$FILE" >/dev/null
SERVICE_CREATED=1
docker service create --detach=true --replicas 1 --name "$SERVICE" --network host \
  --config "source=$CONFIG,target=/etc/traefik/dynamic.yml" \
  traefik:v3.6.2 --entrypoints.web.address=127.0.0.1:18088 \
  --providers.file.filename=/etc/traefik/dynamic.yml --log.level=WARN >/dev/null
wait_proxy 200 || fail "Traefik did not route to healthy RP API"
log "PASS Traefik service proxies real RP API before outage"
: > "$PREPARE"
for i in $(seq 1 120); do
  [ -f "$LEASE" ] && break
  sleep 1
done
[ -f "$LEASE" ] && api_ok || fail "Missing synchronized fresh lease before shutdown"

PID="$(ss -H -ltnp '( sport = :3000 )' |
  sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1)"
[[ "$PID" =~ ^[0-9]+$ ]] && [ "$PID" -gt 2 ] || fail "Cannot identify API listener"
COMMAND="$(ps -p "$PID" -o args= || true)"
[[ "$COMMAND" = *node* ]] &&
[[ "$COMMAND" = *resourceportal-api* || "$COMMAND" = *dist* || "$COMMAND" = *main* ]] ||
  fail "Unrelated process owns port 3000"
CWD="$(readlink -f "/proc/$PID/cwd")"
[[ "$CWD" = "$GITHUB_WORKSPACE" || "$CWD" = "$GITHUB_WORKSPACE/"* ]] ||
  fail "Unexpected API process working directory, refusing signal"
kill -TERM "$PID"; API_STOPPED=1
for i in $(seq 1 45); do
  ! api_ok && break
  sleep 1
done
! api_ok || fail "API did not shut down"
CODE="$(proxy_code)"
case "$CODE" in 502|503|504) ;; *) fail "Expected ingress 502/503/504, got $CODE";; esac
log "PASS API process killed; Traefik returned HTTP $CODE"
START="$(python3 -c 'import time; print(time.monotonic())')"
: > "$OUTAGE"
RESTARTED=0; SCALED=0
while [ ! -f "$RESTORE" ]; do
  ! api_ok || fail "API returned too early during 443s outage"
  AGE="$(python3 - "$START" <<'PY'
import sys,time
print(int(time.monotonic()-float(sys.argv[1])))
PY
)"
  if [ "$AGE" -ge 120 ] && [ "$RESTARTED" -eq 0 ]; then
    BEFORE="$(docker service ps "$SERVICE" --filter desired-state=running --format '{{.ID}}' | head -1)"
    timeout 75 docker service update --force --detach=true "$SERVICE" >/dev/null
    AFTER=""
    for i in $(seq 1 90); do
      AFTER="$(docker service ps "$SERVICE" --filter desired-state=running --format '{{.ID}}' | head -1)"
      [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] && break
      sleep 1
    done
    [ -n "$AFTER" ] && [ "$AFTER" != "$BEFORE" ] || fail "Traefik force-update did not rotate task"
    RESTARTED=1; log "PASS real Traefik task replaced during API outage"
  fi
  if [ "$AGE" -ge 240 ] && [ "$SCALED" -eq 0 ]; then
    timeout 75 docker service scale "$SERVICE=0" >/dev/null
    timeout 75 docker service scale "$SERVICE=1" >/dev/null
    for i in $(seq 1 90); do
      CODE="$(proxy_code)"
      case "$CODE" in 502|503|504) break;; esac
      sleep 1
    done
    case "$CODE" in 502|503|504) ;; *) fail "Proxy did not recover after churn: $CODE";; esac
    SCALED=1; log "PASS real Traefik service scaled 1->0->1 during outage"
  fi
  [ "$AGE" -lt 530 ] || fail "Event sender did not finish within 530 seconds"
  sleep 1
done
[ "$RESTARTED" -eq 1 ] && [ "$SCALED" -eq 1 ] || fail "Incomplete Traefik churn"
AGE="$(python3 - "$START" <<'PY'
import sys,time
print(int(time.monotonic()-float(sys.argv[1])))
PY
)"
[ "$AGE" -ge 443 ] && ! api_ok || fail "API downtime shorter than real 443s event period"
restore_api || fail "API restart failed"
wait_proxy 200 || fail "Recovered API is not reachable through Traefik"
log "PASS real API stopped for $AGE seconds, two Traefik churns and API recovered"
