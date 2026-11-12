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
    printf 'ZITADEL Actions V2 execution search failed (HTTP, authorization or transport).\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  result="$(jq -er --arg id "$id" '
    # ZITADEL may omit BOTH result fields for an empty page. Accept this
    # only with a verified full applied limit; a partially missing, malformed
    # or truncated result must never be mistaken for no global execution.
    def uint: if type == "number" then . >= 0 and . == floor
              elif type == "string" then test("^(0|[1-9][0-9]*)$")
              else false end;
    def number_value: if type == "number" then . else tonumber end;
    if type != "object" or (.pagination | type) != "object" then
      error("invalid response shape")
    else
      . as $response |
      ($response.pagination.appliedLimit // null) as $limit |
      if $limit != null and
         (($limit | uint | not) or ($limit | number_value) < 1 or
          ($limit | number_value) > 100) then
        error("invalid applied limit")
      elif ($response | has("executions") | not) and
           ($response.pagination | has("totalResult") | not) then
        if $limit != null and ($limit | number_value) == 100 then
          "none"
        else error("unverified empty page") end
      elif ($response.executions | type) != "array" or
           ($response.pagination | has("totalResult") | not) or
           ($response.pagination.totalResult | uint | not) or
           (($response.pagination.totalResult | number_value) !=
            ($response.executions | length)) or
           ($response.executions | length) > 100 or
           ($limit != null and
             ($response.executions | length) > ($limit | number_value)) then
        error("incomplete execution list")
      else
        # ZITADEL returns request/response/event executions too. They do
        # not conflict with preaccesstoken, but malformed/ambiguous entries
        # must not conceal an issuer-global function binding.
        def valid_condition:
          (.condition | type) == "object" and
          (.condition | keys | length) == 1 and
          (
            .condition as $c |
            if $c | has("function") then
              ($c.function | type) == "object" and
              ($c.function.name | type) == "string" and
              ($c.function.name | length) > 0
            else
              ($c | to_entries[0]) as $entry |
              ($entry.key == "request" or $entry.key == "response" or
               $entry.key == "event") and
              ($entry.value | type) == "object" and
              ($entry.value | keys | length) == 1 and
              (
                ($entry.value.all == true) or
                (($entry.value.method | type) == "string" and
                 ($entry.value.method | length) > 0 and
                 $entry.key != "event") or
                (($entry.value.service | type) == "string" and
                 ($entry.value.service | length) > 0 and
                 $entry.key != "event") or
                (($entry.value.event | type) == "string" and
                 ($entry.value.event | length) > 0 and
                 $entry.key == "event") or
                (($entry.value.group | type) == "string" and
                 ($entry.value.group | length) > 0 and
                 $entry.key == "event")
              )
            end
          );
        if any($response.executions[]; valid_condition | not) then
          error("invalid execution condition")
        else
          [$response.executions[] |
           select(.condition.function.name == "preaccesstoken")] as $e |
          if ($e | length) == 0 then "none"
          elif ($e | length) == 1 and $e[0].targets == [$id] then "ours"
          else "conflict" end
        end
      end
    end
  ' "$tmp/result" 2>/dev/null)" || {
    printf 'ZITADEL Actions V2 execution search returned an invalid or incomplete page; refusing provisioning.\n' >&2
    rm -rf -- "$tmp"; return 1
  }
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
# The host installer deliberately does NOT install Node.js. Sign the
# negative HTTPS probe with the already pulled, digest-pinned RP API image,
# in an isolated, read-only and network-less ephemeral container. The signing
# secret remains in the protected root-only directory; no key reaches argv.
rp_app_action_sign_probe() {
  local tmp="$1" image="${RP_CFG_API_IMAGE:-}"
  [[ "$tmp" == /* && -d "$tmp" && ! -L "$tmp" && "$image" =~ @sha256:[a-f0-9]{64}$ ]] || return 1
  docker run --rm --interactive --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 0:0 \
    --mount "type=bind,src=$tmp,dst=/rp-action-probe,readonly" \
    --entrypoint node "$image" - /rp-action-probe/key /rp-action-probe/body >"$tmp/conf" <<'NODE'
const { readFileSync } = require("node:fs");
const { createHmac } = require("node:crypto");
const [keyPath, bodyPath] = process.argv.slice(2);
const key = readFileSync(keyPath);
const body = readFileSync(bodyPath);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", key)
  .update(timestamp + ".").update(body).digest("hex");
process.stdout.write('header = "ZITADEL-Signature: t=' + timestamp + ',v1=' + signature + '"\n');
NODE
}
rp_app_action_probe() {
  local id="$1" ref="$2" tmp code
  tmp="$(umask 077; mktemp -d)" || return 1
  rp_app_action_read_key "$id" "$tmp/key" "$ref" || { rm -rf -- "$tmp"; return 1; }
  printf '{"function":"function/preaccesstoken","user":{"id":"invalid-probe-id"},"application":{"client_id":"rp-nonexistent-probe"}}' >"$tmp/body"
  if ! rp_app_action_sign_probe "$tmp"; then
    rm -rf -- "$tmp"
    return 1
  fi
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

# IAM #430: separate confidential invitation OIDC client, provisioned before
# issuer-global Actions V2 can authorize new identities. PAT and client secret
# never appear in process arguments, logs, stack YAML or installer config.
rp_invitation_oidc_http() (
  local method="$1" path="$2" output="$3" data="${4:-}"
  local project="${RP_CFG_ZITADEL_PROJECT_ID:-}" org="${RP_CFG_ZITADEL_ORGANIZATION_ID:-}"
  local host="${RP_CFG_ZITADEL_DOMAIN:-}"
  local patfile="${RP_ZITADEL_MANAGEMENT_PAT_FILE:-/mnt/resourceportal/platform/zitadel-bootstrap/admin.pat}"
  local pat conf
  [[ "$method" == GET || "$method" == POST || "$method" == DELETE ]] || return 1
  [[ "$project" =~ ^[0-9]{1,64}$ && "$org" =~ ^[0-9]{1,64}$ ]] || return 1
  [[ "$path" == "/management/v1/projects/$project/apps/_search" ||
     "$path" == "/management/v1/projects/$project/apps/oidc" ||
     "$path" =~ ^/management/v1/projects/[0-9]{1,64}/apps/[0-9]{1,64}$ ]] || return 1
  [[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ &&
     "$output" == /* && ! -L "$output" &&
     "$patfile" == /* && -f "$patfile" && -r "$patfile" ]] || return 1
  [[ -z "$data" || ( "$data" == /* && -f "$data" && -r "$data" && ! -L "$data" ) ]] || return 1
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

rp_invitation_oidc_client_id_valid() {
  local id="$1"
  [[ -n "$id" && ${#id} -le 256 && "$id" =~ ^[A-Za-z0-9@._-]+$ &&
     "$id" != "${RP_CFG_OIDC_CLIENT_ID:-}" &&
     "$id" != "${RP_CFG_OIDC_CLI_CLIENT_ID:-}" ]]
}

rp_invitation_oidc_search() {
  local output="$1" tmp
  [[ "$output" == /* && "${RP_CFG_ZITADEL_PROJECT_ID:-}" =~ ^[0-9]{1,64}$ ]] || return 1
  tmp="$(umask 077; mktemp)" || return 1
  printf '{"query":{"limit":100}}\n' > "$tmp" || { rm -f "$tmp"; return 1; }
  if ! rp_invitation_oidc_http POST \
      "/management/v1/projects/${RP_CFG_ZITADEL_PROJECT_ID}/apps/_search" \
      "$output" "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  rm -f "$tmp"
  jq -e '
    (.result | type == "array") and
    ((.details.totalResult // .pagination.totalResult // (.result | length)) | tonumber? // -1) <= 100 and
    ((.details.totalResult // .pagination.totalResult // (.result | length)) | tonumber? // -1) >= (.result | length)
  ' "$output" >/dev/null 2>&1
}

rp_invitation_oidc_verify() {
  local client="$1" listing="$2" project="${RP_CFG_ZITADEL_PROJECT_ID:-}"
  local callback="https://${RP_CFG_DOMAIN:-}/api/invitations/onboard/callback"
  local app_id tmp
  rp_invitation_oidc_client_id_valid "$client" || return 1
  app_id="$(jq -er --arg client "$client" '
    [.result[] | select(.oidcConfig.clientId == $client)] |
    if length == 1 then .[0].id | select(type == "string" and test("^[0-9]{1,64}$"))
    else error("ambiguous client") end
  ' "$listing")" || return 1
  tmp="$(umask 077; mktemp)" || return 1
  if ! rp_invitation_oidc_http GET "/management/v1/projects/$project/apps/$app_id" "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  jq -e --arg client "$client" --arg callback "$callback" '
    (.app // .).oidcConfig as $o |
    $o.clientId == $client and
    $o.appType == "OIDC_APP_TYPE_WEB" and
    $o.authMethodType == "OIDC_AUTH_METHOD_TYPE_BASIC" and
    $o.devMode == false and
    $o.responseTypes == ["OIDC_RESPONSE_TYPE_CODE"] and
    $o.grantTypes == ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"] and
    $o.redirectUris == [$callback]
  ' "$tmp" >/dev/null 2>&1
  local status=$?
  rm -f "$tmp"
  return "$status"
}

# Only public client and Swarm secret REFERENCES live here; the confidential
# value remains exclusively in Docker Swarm. This owner-private journal is
# independent of the installer config restored by image-only rollback.
rp_invitation_oidc_recovery_path() {
  local dir="${RP_UPGRADE_STATE_DIR:-${RP_INSTALLER_STATE_DIR:-/var/lib/resourceportal/installer-state}/upgrade}"
  [[ "$dir" == /* && "$dir" != / && ! -L "$dir" ]] || return 1
  printf '%s/invitation-oidc-recovery.json\n' "$dir"
}

rp_invitation_oidc_recovery_record() {
  local app_id="$1" client="$2" ref="$3" path tmp
  # Fresh installations have no upgrade rollback checkpoint.
  [[ -n "${RP_UPGRADE_ACTIVE_CHECKPOINT:-}" ]] || return 0
  path="$(rp_invitation_oidc_recovery_path)" || return 1
  [[ "${RP_UPGRADE_ACTIVE_CHECKPOINT}" == "${path%/*}" &&
     -d "${path%/*}" && ! -L "$path" &&
     "$app_id" =~ ^[0-9]{1,64}$ &&
     "$ref" =~ ^rp_invitation_oidc_secret_[a-f0-9]{16}$ ]] || return 1
  rp_invitation_oidc_client_id_valid "$client" || return 1
  local state="${path%/*}/state.json" source target manifest_sha
  [[ -r "$state" && ! -L "$state" ]] || return 1
  source="$(jq -er '.sourceVersion | select(type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$state")" || return 1
  target="$(jq -er '.targetVersion | select(type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$state")" || return 1
  manifest_sha="$(jq -er '.targetManifestSha256 | select(type == "string" and test("^[a-f0-9]{64}$"))' "$state")" || return 1
  tmp="$(umask 077; mktemp "${path%/*}/.invitation-recovery.XXXXXX")" || return 1
  if ! jq -n --arg id "$app_id" --arg client "$client" --arg ref "$ref" \
       --arg project "${RP_CFG_ZITADEL_PROJECT_ID}" --arg host "${RP_CFG_ZITADEL_DOMAIN}" \
       --arg domain "${RP_CFG_DOMAIN}" --arg source "$source" --arg target "$target" \
       --arg sha "$manifest_sha" \
       '{appId:$id,clientId:$client,secretRef:$ref,projectId:$project,issuerHost:$host,domain:$domain,
         createdForSourceVersion:$source,createdForTargetVersion:$target,createdForManifestSha256:$sha}' > "$tmp" ||
     ! chmod 0600 "$tmp" || ! mv -f -- "$tmp" "$path"; then
    rm -f -- "$tmp"
    return 1
  fi
}

# If the previous target was rolled back image-only, its confidential client
# still exists in ZITADEL and its versioned Swarm secret is still sealed.
# Reattach ONLY after verifying both physical resources and exact namespace.
rp_invitation_oidc_recovery_load() {
  local path="$1" candidate_client="$2" candidate_ref="$3"
  [[ -f "$path" && ! -L "$path" && "$(stat -c %a "$path")" == 600 ]] || return 1
  jq -e --arg project "${RP_CFG_ZITADEL_PROJECT_ID:-}" \
    --arg host "${RP_CFG_ZITADEL_DOMAIN:-}" --arg domain "${RP_CFG_DOMAIN:-}" '
      .projectId == $project and .issuerHost == $host and .domain == $domain and
      (.appId | type == "string" and test("^[0-9]{1,64}$")) and
      (.clientId | type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9@._-]+$")) and
      (.secretRef | type == "string" and test("^rp_invitation_oidc_secret_[a-f0-9]{16}$"))
    ' "$path" >/dev/null 2>&1 || return 1
  RP_INVITATION_RECOVERED_CLIENT="$(jq -er '.clientId' "$path")" || return 1
  RP_INVITATION_RECOVERED_REF="$(jq -er '.secretRef' "$path")" || return 1
  [[ ( -z "$candidate_client" && -z "$candidate_ref" ) ||
     ( "$candidate_client" == "$RP_INVITATION_RECOVERED_CLIENT" &&
       "$candidate_ref" == "$RP_INVITATION_RECOVERED_REF" ) ]]
}

# Immutable per-attempt evidence prevents deleting a preexisting
# credential when a later, unrelated tested rollback restores its source DB.
# The snapshot marker is written only AFTER both RP and ZITADEL swaps commit.
rp_invitation_oidc_created_for_restored_checkpoint() {
  local journal="$1" phase="${2:-rollback-failed}" dir state actual expected
  dir="${journal%/*}"
  state="$dir/state.json"
  [[ "$journal" == "$(rp_invitation_oidc_recovery_path)" &&
     -r "$journal" && ! -L "$journal" && -r "$state" && ! -L "$state" &&
     -r "$dir/previous-stack.yml" && ! -L "$dir/previous-stack.yml" ]] || return 1
  expected="$(jq -er '.previousStackSha256' "$state")" || return 1
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 1
  actual="$(sha256sum "$dir/previous-stack.yml" | cut -d' ' -f1)" || return 1
  [[ "$actual" == "$expected" ]] || return 1
  jq -e --slurpfile cp "$state" --arg phase "$phase" '
     ($cp | length == 1) and
     ($cp[0].databaseSnapshotState == "restored") and
     ($cp[0].phase == $phase) and
     .createdForSourceVersion == $cp[0].sourceVersion and
     .createdForTargetVersion == $cp[0].targetVersion and
     .createdForManifestSha256 == $cp[0].targetManifestSha256 and
     (.createdForManifestSha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "$journal" >/dev/null 2>&1
}

rp_invitation_oidc_recovery_forget() {
  local path
  path="$(rp_invitation_oidc_recovery_path)" || return 1
  [[ ! -L "$path" ]] || return 1
  rm -f -- "$path"
}

# Compensate a failed, not-yet-journaled create, so its lost secret cannot
# make every later read-only preflight reject an orphaned application.
rp_invitation_oidc_discard_created() {
  local app_id="$1" ref="${2:-}" tmp
  [[ "$app_id" =~ ^[0-9]{1,64}$ ]] || return 1
  tmp="$(umask 077; mktemp)" || return 1
  if ! rp_invitation_oidc_http DELETE \
       "/management/v1/projects/${RP_CFG_ZITADEL_PROJECT_ID}/apps/$app_id" "$tmp"; then
    rm -f -- "$tmp"; return 1
  fi
  rm -f -- "$tmp"
  if [[ -n "$ref" ]]; then
    [[ "$ref" =~ ^rp_invitation_oidc_secret_[a-f0-9]{16}$ ]] || return 1
    docker secret rm "$ref" >/dev/null 2>&1 || return 1
  fi
}

# A tested database rollback removes an app created AFTER its ZITADEL
# snapshot, so discard only the newly created secret. An image-only rollback
# preserves the app and its sealed secret, and keeps the verified journal for
# the next upgrade's read-only preflight. Never delete pre-existing clients.
rp_invitation_oidc_rollback_recover() {
  local policy="$1" path ref
  path="$(rp_invitation_oidc_recovery_path)" || return 1
  [[ ! -L "$path" ]] || return 1
  [[ -f "$path" ]] || return 0
  if [[ "$policy" == tested ]] &&
     ( rp_invitation_oidc_created_for_restored_checkpoint "$path" rolling-back ||
       rp_invitation_oidc_created_for_restored_checkpoint "$path" rollback-failed ); then
    rp_invitation_oidc_recovery_load "$path" \
      "${RP_CFG_INVITATION_OIDC_CLIENT_ID:-}" "${RP_CFG_INVITATION_OIDC_SWARM_REF:-}" || return 1
    ref="$RP_INVITATION_RECOVERED_REF"
    # The previous stack has been restored, and no target service should
    # still require this secret. Repeat safely if a prior cleanup completed.
    if docker secret inspect "$ref" >/dev/null 2>&1; then
      docker secret rm "$ref" >/dev/null 2>&1 || return 1
    fi
    rp_invitation_oidc_recovery_forget || return 1
    unset RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
    RP_INVITATION_OIDC_CREATED_IN_ATTEMPT=false
    return 0
  fi
  # A new client must never be silently treated as a preexisting one if its
  # saved checkpoint was lost/tampered before the DB restore was certified.
  if [[ "$policy" == tested &&
        "${RP_INVITATION_OIDC_CREATED_IN_ATTEMPT:-false}" == true ]]; then
    return 1
  fi
  rp_invitation_oidc_preflight
}

# Read-only gate runs BEFORE any quiesce/snapshot/DB changes. The legacy
# (0.2.152) state with BOTH client references absent can be provisioned.
rp_invitation_oidc_preflight() {
  local client="${RP_CFG_INVITATION_OIDC_CLIENT_ID:-}"
  local ref="${RP_CFG_INVITATION_OIDC_SWARM_REF:-}" tmp recovery recovered=false
  recovery="$(rp_invitation_oidc_recovery_path)" || return 1
  if [[ -e "$recovery" || -L "$recovery" ]]; then
    if ! rp_invitation_oidc_recovery_load "$recovery" "$client" "$ref"; then
      printf 'Upgrade blocked before shutdown: invitation OIDC recovery journal is invalid or mismatched.\n' >&2
      return 1
    fi
    client="$RP_INVITATION_RECOVERED_CLIENT"
    ref="$RP_INVITATION_RECOVERED_REF"
    # A certified tested rollback restored ZITADEL without the new app.
    # Only a matching failed checkpoint may postpone physical verification;
    # checkpoint_prepare must reconcile the previous stack and secret first.
    # Do NOT reattach stale refs or create another app in this preflight.
    if rp_invitation_oidc_created_for_restored_checkpoint "$recovery" rollback-failed; then
      return 0
    fi
    recovered=true
  fi
  if [[ "${RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED:-false}" != true ]]; then
    if [[ -n "$client" || -n "$ref" ]]; then
      printf 'Upgrade blocked before shutdown: invitation OAuth references require certified Actions V2.\n' >&2
      return 1
    fi
    return 0
  fi
  [[ "${RP_CFG_DOMAIN:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || return 1
  if [[ -n "$client" || -n "$ref" ]]; then
    if ! rp_invitation_oidc_client_id_valid "$client" ||
       [[ ! "$ref" =~ ^rp_invitation_oidc_secret_[a-f0-9]{16}$ ]] ||
       ! docker secret inspect "$ref" >/dev/null 2>&1; then
      printf 'Upgrade blocked before shutdown: invitation OIDC client/secret references are incomplete or missing.\n' >&2
      return 1
    fi
  fi
  tmp="$(umask 077; mktemp -d)" || return 1
  if ! rp_invitation_oidc_search "$tmp/apps"; then
    printf 'Upgrade blocked before shutdown: cannot verify invitation clients with ZITADEL.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  if [[ -n "$client" ]]; then
    if [[ "$recovered" == true ]] &&
       ! jq -e --arg id "$(jq -er '.appId' "$recovery")" --arg client "$client"           '[.result[] | select(.id == $id and .oidcConfig.clientId == $client)] | length == 1'           "$tmp/apps" >/dev/null 2>&1; then
      printf 'Upgrade blocked: recovered invitation app ID does not match the physical ZITADEL app.\n' >&2
      rm -rf -- "$tmp"; return 1
    fi
    if ! rp_invitation_oidc_verify "$client" "$tmp/apps"; then
      printf 'Upgrade blocked: invitation OAuth client is not a verified isolated confidential code-only app.\n' >&2
      rm -rf -- "$tmp"; return 1
    fi
  elif jq -e '[.result[] | select(.name == "ResourcePortal Invitation Proof")] | length > 0' "$tmp/apps" >/dev/null; then
    printf 'Upgrade blocked: orphaned invitation app exists without recoverable secret; review manually.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  rm -rf -- "$tmp"
  if [[ "$recovered" == true ]]; then
    RP_CFG_INVITATION_OIDC_CLIENT_ID="$client"
    RP_CFG_INVITATION_OIDC_SWARM_REF="$ref"
    export RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
  fi
}

# Called after the protected 2-DB snapshot for upgrades and after ZITADEL
# bootstrap for fresh installs. No client is reused without validated refs.
rp_invitation_oidc_prepare() {
  [[ "${RP_CFG_APP_CONSUMER_ACTIONS_V2_CERTIFIED:-false}" == true ]] || return 0
  rp_invitation_oidc_preflight || return 1
  [[ -z "${RP_CFG_INVITATION_OIDC_CLIENT_ID:-}" ]] || return 0
  local tmp app_id client ref=''
  tmp="$(umask 077; mktemp -d)" || return 1
  jq -n --arg callback "https://${RP_CFG_DOMAIN}/api/invitations/onboard/callback" \
    --arg origin "https://${RP_CFG_DOMAIN}" '{
      name:"ResourcePortal Invitation Proof",
      redirectUris:[$callback], responseTypes:["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes:["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
      appType:"OIDC_APP_TYPE_WEB", authMethodType:"OIDC_AUTH_METHOD_TYPE_BASIC",
      postLogoutRedirectUris:[], additionalOrigins:[$origin],
      version:"OIDC_VERSION_1_0", devMode:false,
      accessTokenType:"OIDC_TOKEN_TYPE_JWT", idTokenUserinfoAssertion:true,
      loginVersion:{loginV1:{}}
    }' > "$tmp/request" || { rm -rf -- "$tmp"; return 1; }
  if ! rp_invitation_oidc_http POST \
      "/management/v1/projects/${RP_CFG_ZITADEL_PROJECT_ID}/apps/oidc" \
      "$tmp/created" "$tmp/request"; then
    rm -rf -- "$tmp"; return 1
  fi
  app_id="$(jq -er '.appId | select(type=="string" and test("^[0-9]{1,64}$"))' "$tmp/created")" || {
    printf 'Invitation app was created without a recoverable ID; manual ZITADEL reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  }
  if ! client="$(jq -er '.clientId | select(type=="string")' "$tmp/created")" ||
     ! rp_invitation_oidc_client_id_valid "$client" ||
     ! jq -e '.clientSecret | type == "string" and length >= 16' "$tmp/created" >/dev/null; then
    rp_invitation_oidc_discard_created "$app_id" || \
      printf 'Invitation app compensation failed; manual reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  if ! (umask 077; printf '%s' "$(jq -er '.clientSecret' "$tmp/created")" > "$tmp/secret"); then
    rp_invitation_oidc_discard_created "$app_id" || \
      printf 'Invitation app compensation failed; manual reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  if ! rp_invitation_oidc_search "$tmp/apps" ||
     ! rp_invitation_oidc_verify "$client" "$tmp/apps"; then
    rp_invitation_oidc_discard_created "$app_id" || \
      printf 'Invitation app compensation failed; manual reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  ref="$(rp_ensure_versioned_swarm_secret rp_invitation_oidc_secret "$tmp/secret")" || {
    rp_invitation_oidc_discard_created "$app_id" || \
      printf 'Invitation app compensation failed; manual reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  }
  if [[ ! "$ref" =~ ^rp_invitation_oidc_secret_[a-f0-9]{16}$ ]] ||
     ! docker secret inspect "$ref" >/dev/null 2>&1 ||
     ! rp_invitation_oidc_recovery_record "$app_id" "$client" "$ref"; then
    rp_invitation_oidc_discard_created "$app_id" "$ref" || \
      printf 'Invitation app/secret compensation failed; manual reconciliation is required.\n' >&2
    rm -rf -- "$tmp"; return 1
  fi
  RP_INVITATION_OIDC_CREATED_IN_ATTEMPT=true
  RP_CFG_INVITATION_OIDC_CLIENT_ID="$client"
  RP_CFG_INVITATION_OIDC_SWARM_REF="$ref"
  export RP_CFG_INVITATION_OIDC_CLIENT_ID RP_CFG_INVITATION_OIDC_SWARM_REF
  rm -rf -- "$tmp"
}
