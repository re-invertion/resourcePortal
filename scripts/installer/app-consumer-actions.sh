#!/usr/bin/env bash
# ZITADEL Actions V2 controlled lifecycle: global execution owned exclusively by RP.
rp_app_action_http() (
  local method="$1" path="$2" output="$3" data="${4:-}"
  local patfile="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"
  local host="${RP_CFG_ZITADEL_DOMAIN:-}" org="${RP_CFG_ZITADEL_ORGANIZATION_ID:-}" pat conf
  [[ "$method" == GET || "$method" == POST || "$method" == PUT ]] || return 1
  [[ "$path" =~ ^/v2/actions/(targets(/[0-9]{1,64})?|executions(/search)?)$ ]] || return 1
  [[ "$output" == /* && ! -L "$output" && "$host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ &&
    "$org" =~ ^[0-9]{1,64}$ && "$patfile" == /* && -r "$patfile" ]] || return 1
  [[ -z "$data" || ( "$data" == /* && -r "$data" && ! -L "$data" ) ]] || return 1
  IFS= read -r pat < "$patfile" || [[ -n "$pat" ]] || return 1
  [[ "$pat" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || return 1
  conf="$(umask 077; mktemp)" || return 1
  trap 'rm -f -- "$conf"' EXIT
  (umask 077; printf 'header = "Authorization: Bearer %s"\nheader = "x-zitadel-orgid: %s"\n' "$pat" "$org") > "$conf" || return 1
  unset pat
  if [[ -n "$data" ]]; then
    curl --silent --show-error --fail --no-location --proto '=https' --max-time 15 \
      --config "$conf" --header 'Content-Type: application/json' \
      --request "$method" --data-binary "@$data" --output "$output" "https://$host$path"
  else
    curl --silent --show-error --fail --no-location --proto '=https' --max-time 15 \
      --config "$conf" --request "$method" --output "$output" "https://$host$path"
  fi
)
rp_app_action_execution_state() {
  local id="$1" resultvar="$2" tmp result
  [[ "$id" =~ ^[0-9]{1,64}$ ]] || return 1
  tmp="$(umask 077; mktemp -d)" || return 1
  printf '{"pagination":{"limit":100}}\n' >"$tmp/request"
  if ! rp_app_action_http POST /v2/actions/executions/search "$tmp/result" "$tmp/request"; then
    rm -rf -- "$tmp"; return 1
  fi
  result="$(jq -er --arg id "$id" '
    if (.executions | type) != "array" or
       ((.pagination.totalResult | tonumber) != (.executions|length)) or
       (.executions|length) > 100 then error("incomplete") else
      [.executions[] | select(.condition.function.name == "preaccesstoken")] as $e |
      if ($e|length) == 0 then "none"
      elif ($e|length) == 1 and $e[0].targets == [$id] then "ours"
      else "conflict" end
    end
  ' "$tmp/result" 2>/dev/null)" || { rm -rf -- "$tmp"; return 1; }
  rm -rf -- "$tmp"
  printf -v "$resultvar" '%s' "$result"
}
rp_app_action_read_key() {
  local id="$1" outfile="$2" expected="${3:-}" tmp
  [[ "$id" =~ ^[0-9]{1,64}$ && "$outfile" == /* && ! -L "$outfile" ]] || return 1
  tmp="$(umask 077; mktemp)" || return 1
  if ! rp_app_action_http GET "/v2/actions/targets/$id" "$tmp" ||
     ! jq -e --arg id "$id" --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" '
       .target.id == $id and .target.endpoint == $url and
       .target.payloadType == "PAYLOAD_TYPE_JSON" and
       .target.restWebhook.interruptOnError == true and
       (.target.signingKey | type == "string" and length >= 32 and length <= 512)
     ' "$tmp" >/dev/null; then
    rm -f -- "$tmp"; return 1
  fi
  (umask 077; printf '%s' "$(jq -er '.target.signingKey' "$tmp")" > "$outfile") ||
    { rm -f -- "$tmp" "$outfile"; return 1; }
  rm -f -- "$tmp"
  if [[ -n "$expected" && "$(rp_versioned_secret_name rp_app_consumer_action_hmac "$outfile")" != "$expected" ]]; then
    rm -f -- "$outfile"; return 1
  fi
}
rp_app_action_prepare() {
  local id="${RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID:-}" ref="${RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF:-}"
  local certified="${RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED:-false}" state tmp
  [[ "${RP_CFG_DOMAIN:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || return 1
  tmp="$(umask 077; mktemp -d)" || return 1
  if [[ "$certified" == true ]]; then
    [[ "$id" =~ ^[0-9]{1,64}$ && "$ref" =~ ^rp_app_consumer_action_hmac_[a-f0-9]{16}$ ]] ||
      { rm -rf -- "$tmp"; return 1; }
    rp_app_action_read_key "$id" "$tmp/key" "$ref" &&
      docker secret inspect "$ref" >/dev/null 2>&1 &&
      rp_app_action_execution_state "$id" state && [[ "$state" == ours ]] ||
      { rm -rf -- "$tmp"; return 1; }
    RP_APP_ACTION_UPGRADE_NEW=false
  else
    [[ "$certified" == false && -z "$id" && -z "$ref" ]] ||
      { rm -rf -- "$tmp"; return 1; }
    rp_app_action_execution_state 0 state && [[ "$state" == none ]] ||
      { rm -rf -- "$tmp"; return 1; }
    jq -n --arg url "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken" \
      '{name:"resourceportal-app-consumer-entitlements",endpoint:$url,timeout:"5s",
        payloadType:"PAYLOAD_TYPE_JSON",restWebhook:{interruptOnError:true}}' >"$tmp/create" || return 1
    rp_app_action_http POST /v2/actions/targets "$tmp/created" "$tmp/create" ||
      { rm -rf -- "$tmp"; return 1; }
    id="$(jq -er '.id | select(type == "string" and test("^[0-9]{1,64}$"))' "$tmp/created")" ||
      { rm -rf -- "$tmp"; return 1; }
    rp_app_action_read_key "$id" "$tmp/key" ||
      { rm -rf -- "$tmp"; return 1; }
    ref="$(rp_ensure_versioned_swarm_secret rp_app_consumer_action_hmac "$tmp/key")" ||
      { rm -rf -- "$tmp"; return 1; }
    [[ "$ref" =~ ^rp_app_consumer_action_hmac_[a-f0-9]{16}$ ]] ||
      { rm -rf -- "$tmp"; return 1; }
    RP_APP_ACTION_UPGRADE_NEW=true
    RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID="$id"
    RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF="$ref"
    RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED=true
    export RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF \
      RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED
  fi
  rm -rf -- "$tmp"
}
rp_app_action_probe() {
  local id="$1" ref="$2" tmp code
  command -v node >/dev/null || return 1
  tmp="$(umask 077; mktemp -d)" || return 1
  rp_app_action_read_key "$id" "$tmp/key" "$ref" || { rm -rf -- "$tmp"; return 1; }
  printf '{"function":"function/preaccesstoken","user":{"id":"invalid-probe-id"},"application":{"client_id":"rp-nonexistent-probe"}}' >"$tmp/body"
  if ! node - "$tmp/key" "$tmp/body" "$tmp/conf" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { createHmac } = require("node:crypto");
const [keyPath, bodyPath, configPath] = process.argv.slice(2);
const key = readFileSync(keyPath);
const body = readFileSync(bodyPath);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", key)
  .update(timestamp + ".").update(body).digest("hex");
writeFileSync(configPath,
  'header = "ZITADEL-Signature: t=' + timestamp + ',v1=' + signature + '"\n',
  { mode: 0o600 });
NODE
  then rm -rf -- "$tmp"; return 1; fi
  chmod 0600 "$tmp/conf"
  code="$(curl --silent --show-error --no-location --proto '=https' --max-time 15 \
    --config "$tmp/conf" --header 'Content-Type: application/json' \
    --data-binary "@$tmp/body" --output "$tmp/response" --write-out '%{http_code}' \
    "https://$RP_CFG_DOMAIN/api/app-consumer-actions/preaccesstoken")" ||
    { rm -rf -- "$tmp"; return 1; }
  rm -rf -- "$tmp"
  [[ "$code" == 403 ]] || { printf 'App Consumer signed callback probe returned HTTP %s.\n' "$code" >&2; return 1; }
}
rp_app_action_detach_if_owned() {
  local id="$1" state tmp
  rp_app_action_execution_state "$id" state || return 1
  case "$state" in none) return 0 ;; ours) ;; *) return 1 ;; esac
  tmp="$(umask 077; mktemp -d)" || return 1
  printf '{"condition":{"function":{"name":"preaccesstoken"}},"targets":[]}\n' >"$tmp/request"
  rp_app_action_http PUT /v2/actions/executions "$tmp/result" "$tmp/request" ||
    { rm -rf -- "$tmp"; return 1; }
  rm -rf -- "$tmp"
  rp_app_action_execution_state "$id" state && [[ "$state" == none ]]
}
rp_app_action_activate() {
  local id="$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" ref="$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" state tmp
  [[ "${RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED:-}" == true ]] || return 1
  rp_app_action_probe "$id" "$ref" || return 1
  rp_app_action_execution_state "$id" state || return 1
  [[ "$state" == none || "$state" == ours ]] || return 1
  if [[ "$state" == none ]]; then
    tmp="$(umask 077; mktemp -d)" || return 1
    jq -n --arg id "$id" '{condition:{function:{name:"preaccesstoken"}},targets:[$id]}' >"$tmp/request"
    rp_app_action_http PUT /v2/actions/executions "$tmp/result" "$tmp/request" ||
      { rm -rf -- "$tmp"; return 1; }
    rm -rf -- "$tmp"
  fi
  tmp="$(umask 077; mktemp -d)" || return 1
  rp_app_action_read_key "$id" "$tmp/key" "$ref" &&
    rp_verify_app_consumer_actions_v2_binding "$id" "$tmp/key"
  local result=$?
  rm -rf -- "$tmp"
  return "$result"
}
rp_app_action_checkpoint_record() {
  local dir="${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" tmp
  [[ -n "$dir" && ! -L "$dir" && -r "$dir/state.json" ]] || return 1
  tmp="$(mktemp "$dir/.action-checkpoint.XXXXXX")" || return 1
  if ! jq --arg id "$RP_CFG_APP_CONSUMER_ACTIONS_V2_TARGET_ID" \
    --arg ref "$RP_CFG_APP_CONSUMER_ACTIONS_V2_SIGNING_SWARM_REF" \
    --argjson introduced "${RP_APP_ACTION_UPGRADE_NEW:-false}" \
    '.appConsumerAction={targetId:$id,secretRef:$ref,introduced:$introduced}' \
    "$dir/state.json" >"$tmp" || ! chmod 0600 "$tmp" || ! mv -f "$tmp" "$dir/state.json"; then
    rm -f -- "$tmp"; return 1
  fi
}
rp_app_action_checkpoint_detach() {
  local dir="$1" id ref introduced tmp
  [[ -r "$dir/state.json" && ! -L "$dir/state.json" ]] || return 1
  introduced="$(jq -r '.appConsumerAction.introduced // false' "$dir/state.json")" || return 1
  [[ "$introduced" == true ]] || return 0
  id="$(jq -er '.appConsumerAction.targetId' "$dir/state.json")" || return 1
  ref="$(jq -er '.appConsumerAction.secretRef' "$dir/state.json")" || return 1
  [[ "$id" =~ ^[0-9]{1,64}$ && "$ref" =~ ^rp_app_consumer_action_hmac_[a-f0-9]{16}$ ]] || return 1
  # Database restore can already have removed an Action target created only
  # on the candidate ZITADEL database. No active execution in source ZITADEL
  # is the safe restored state; do NOT fail merely because its target is gone.
  local state
  rp_app_action_execution_state "$id" state || return 1
  [[ "$state" == none ]] && return 0
  [[ "$state" == ours ]] || return 1
  tmp="$(umask 077; mktemp -d)" || return 1
  rp_app_action_read_key "$id" "$tmp/key" "$ref" &&
    rp_app_action_detach_if_owned "$id"
  local result=$?
  rm -rf -- "$tmp"
  return "$result"
}
