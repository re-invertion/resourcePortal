#!/usr/bin/env bash

rp_validate_enrollment_role() {
  case "$1" in worker|manager) return 0 ;; *) return 1 ;; esac
}

rp_spki_pin() {
  local cert="$1"
  [[ "$cert" == /* && -r "$cert" ]] || return 1
  printf 'sha256//'
  openssl x509 -in "$cert" -pubkey -noout \
    | openssl pkey -pubin -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A
  printf '\n'
}

rp_generate_enrollment_tls_identity() {
  local cert="$1" key="$2" common_name="${3:-resourceportal-installer-enrollment}"
  [[ "$cert" == /* && "$key" == /* ]] || return 1
  umask 077
  mkdir -p "$(dirname "$cert")" "$(dirname "$key")"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
    -keyout "$key" -out "$cert" -days 3650 \
    -subj "/CN=${common_name}" >/dev/null 2>&1
  chmod 0600 "$key" "$cert"
}

rp_write_join_bundle() {
  local target="$1" role="$2" token="$3" expires_at="$4" endpoint="$5" pin="$6"
  rp_validate_enrollment_role "$role" || return 1
  [[ "$target" == /* ]] || return 1
  [[ "$token" =~ ^[A-Za-z0-9_-]{40,}$ ]] || return 1
  [[ "$endpoint" =~ ^https://[^[:space:]]+:[0-9]+$ ]] || return 1
  [[ "$pin" =~ ^sha256//[A-Za-z0-9+/=_-]+$ ]] || return 1
  umask 077
  mkdir -p "$(dirname "$target")"
  cat >"$target" <<EOF_BUNDLE
RP_ENROLLMENT_ROLE=$role
RP_ENROLLMENT_TOKEN=$token
RP_ENROLLMENT_EXPIRES_AT=$expires_at
RP_ENROLLMENT_ENDPOINT=$endpoint
RP_ENROLLMENT_PIN=$pin
EOF_BUNDLE
  chmod 0600 "$target"
}

rp_bundle_value() {
  local file="$1" key="$2" line
  [[ "$file" == /* && -r "$file" && "$key" =~ ^RP_ENROLLMENT_[A-Z_]+$ ]] || return 1
  line="$(grep -m1 "^${key}=" "$file")" || return 1
  printf '%s\n' "${line#*=}"
}

rp_join_swarm_for_enrollment() {
  local role="$1" join_token="$2" manager_endpoint="$3" expected_cluster_id="$4"
  local state local_cluster_id control_available
  rp_validate_enrollment_role "$role" || return 1
  state="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  if [[ "$state" == active ]]; then
    local_cluster_id="$(docker info --format '{{.Swarm.Cluster.ID}}')" || return 1
    [[ -n "$local_cluster_id" && "$local_cluster_id" == "$expected_cluster_id" ]] || {
      printf 'Host is already joined to a different Docker Swarm cluster.\n' >&2
      return 1
    }
    control_available="$(docker info --format '{{.Swarm.ControlAvailable}}')" || return 1
    if [[ "$role" == manager && "$control_available" != true ]]; then
      printf 'Host is already joined as a worker, but the enrollment bundle requires manager role.\n' >&2
      return 1
    fi
    if [[ "$role" == worker && "$control_available" == true ]]; then
      printf 'Host is already joined as a manager, but the enrollment bundle requires worker role.\n' >&2
      return 1
    fi
    return 0
  fi
  [[ "$state" == inactive || -z "$state" ]] || {
    printf 'Docker Swarm local node state is not joinable: %s\n' "$state" >&2
    return 1
  }
  docker swarm join --token "$join_token" "$manager_endpoint"
}

rp_docker_socket_group_gid() {
  local socket_path="${1:-/var/run/docker.sock}" gid
  [[ -S "$socket_path" || -e "$socket_path" ]] || return 1
  gid="$(stat -c '%g' "$socket_path")" || return 1
  [[ "$gid" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$gid"
}

rp_sync_swarm_join_token_secrets() {
  local tmpdir worker_file manager_file worker_ref manager_ref
  tmpdir="$(mktemp -d /tmp/resourceportal-enrollment-tokens.XXXXXX)" || return 1
  chmod 0700 "$tmpdir"
  worker_file="$tmpdir/worker"; manager_file="$tmpdir/manager"
  trap 'rm -rf "$tmpdir"' RETURN
  umask 077
  docker swarm join-token -q worker >"$worker_file" || return 1
  docker swarm join-token -q manager >"$manager_file" || return 1
  chmod 0600 "$worker_file" "$manager_file"
  worker_ref="$(rp_ensure_versioned_swarm_secret installer_swarm_worker_token "$worker_file")" || return 1
  manager_ref="$(rp_ensure_versioned_swarm_secret installer_swarm_manager_token "$manager_file")" || return 1
  RP_CFG_ENROLLMENT_WORKER_TOKEN_REF="$worker_ref"
  RP_CFG_ENROLLMENT_MANAGER_TOKEN_REF="$manager_ref"
  export RP_CFG_ENROLLMENT_WORKER_TOKEN_REF RP_CFG_ENROLLMENT_MANAGER_TOKEN_REF
  rm -rf "$tmpdir"; trap - RETURN
}

rp_start_enrollment_listener() {
  local cert="$1" key="$2" cert_ref key_ref service_name port manager_endpoint cluster_id control_network docker_socket_gid
  [[ -r "$cert" && -r "$key" ]] || return 1
  rp_sync_swarm_join_token_secrets || return 1
  cert_ref="$(rp_ensure_versioned_swarm_secret installer_enrollment_tls_cert "$cert")" || return 1
  key_ref="$(rp_ensure_versioned_swarm_secret installer_enrollment_tls_key "$key")" || return 1
  service_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}-installer-enrollment"
  control_network="${RP_CFG_STACK_NAME:-resourceportal-control-plane}_rp-control"
  port="${RP_CFG_ENROLLMENT_PORT:-7443}"
  manager_endpoint="${RP_CFG_SWARM_ADVERTISE_ADDR}:2377"
  cluster_id="$(docker info --format '{{.Swarm.Cluster.ID}}')" || return 1
  docker_socket_gid="$(rp_docker_socket_group_gid /var/run/docker.sock)" || return 1

  docker service rm "$service_name" >/dev/null 2>&1 || true
  docker service create \
    --name "$service_name" \
    --network "$control_network" \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
    --group-add "$docker_socket_gid" \
    --publish "mode=host,target=7443,published=${port},protocol=tcp" \
    --secret source=rp_database_url,target=rp_database_url \
    --secret source="$RP_CFG_ENROLLMENT_WORKER_TOKEN_REF",target=installer_worker_token \
    --secret source="$RP_CFG_ENROLLMENT_MANAGER_TOKEN_REF",target=installer_manager_token \
    --secret source="$cert_ref",target=installer_tls_cert \
    --secret source="$key_ref",target=installer_tls_key \
    --env DATABASE_URL_FILE=/run/secrets/rp_database_url \
    --env INSTALLER_SWARM_WORKER_TOKEN_FILE=/run/secrets/installer_worker_token \
    --env INSTALLER_SWARM_MANAGER_TOKEN_FILE=/run/secrets/installer_manager_token \
    --env INSTALLER_ENROLLMENT_TLS_CERT_FILE=/run/secrets/installer_tls_cert \
    --env INSTALLER_ENROLLMENT_TLS_KEY_FILE=/run/secrets/installer_tls_key \
    --env INSTALLER_SWARM_MANAGER_ENDPOINT="$manager_endpoint" \
    --env INSTALLER_STORAGE_SERVER_ADDRESS="$RP_CFG_STORAGE_SERVER_ADDRESS" \
    --env INSTALLER_CLUSTER_ID="$cluster_id" \
    --env INSTALLER_VERSION="${RP_CFG_RELEASE_VERSION:-unknown}" \
    --env INSTALLER_SWARM_ADVERTISE_ADDR="$RP_CFG_SWARM_ADVERTISE_ADDR" \
    --env INSTALLER_CLUSTER_CIDR="$RP_CFG_CLUSTER_CIDR" \
    --env INSTALLER_ENROLLMENT_PORT=7443 \
    "$RP_CFG_API_IMAGE" node dist/src/internal/installer-enrollment.runner.js >/dev/null
}

rp_prepare_enrollment_output_dir() {
  local path="$1" image="$2" owner
  [[ -n "$path" && -n "$image" ]] || return 1
  owner="$(docker run --rm --entrypoint sh "$image" -c 'printf "%s:%s\n" "$(id -u node)" "$(id -g node)"')" || return 1
  [[ "$owner" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  install -d -m 0700 "$path" || return 1
  chown "$owner" "$path" || return 1
  chmod 0700 "$path" || return 1
}

rp_issue_node_bundle_cli() {
  local role="$1" output_bundle="$2"
  local cert="${RP_ENROLLMENT_CERT_PATH:-/var/lib/resourceportal/installer-state/enrollment/tls.crt}" pin endpoint
  rp_validate_enrollment_role "$role" || { printf 'Enrollment role must be worker or manager.\n' >&2; return 2; }
  [[ "$output_bundle" == /* ]] || { printf 'Enrollment bundle output path must be absolute.\n' >&2; return 2; }
  [[ -r "$cert" ]] || { printf 'Enrollment TLS certificate is not readable: %s\n' "$cert" >&2; return 1; }
  pin="$(rp_spki_pin "$cert")" || return 1
  endpoint="https://${RP_CFG_SWARM_ADVERTISE_ADDR:?RP_CFG_SWARM_ADVERTISE_ADDR is required}:7443"
  rp_issue_enrollment_bundle "$role" "$output_bundle" "$endpoint" "$pin"
}

rp_issue_enrollment_bundle() {
  local role="$1" output_bundle="$2" enrollment_endpoint="$3" pin="$4" workdir output_file service_name timeout elapsed state control_network
  rp_validate_enrollment_role "$role" || return 1
  workdir="$(mktemp -d /tmp/resourceportal-enrollment-issue.XXXXXX)" || return 1
  rp_prepare_enrollment_output_dir "$workdir" "${RP_CFG_API_IMAGE:?RP_CFG_API_IMAGE is required}" || { rm -rf "$workdir"; return 1; }
  output_file="$workdir/enrollment.json"
  service_name="${RP_CFG_STACK_NAME:-resourceportal-control-plane}-enrollment-issue-$(date +%s)"
  control_network="${RP_CFG_STACK_NAME:-resourceportal-control-plane}_rp-control"
  trap 'rm -rf "$workdir"' RETURN
  docker service create \
    --detach \
    --name "$service_name" --restart-condition none \
    --network "$control_network" \
    --constraint 'node.role==manager' \
    --constraint 'node.labels.resourceportal.storage.authoritative==true' \
    --secret source=rp_database_url,target=rp_database_url \
    --mount "type=bind,src=$workdir,dst=/enrollment-output" \
    --env INSTALLER_ENROLLMENT_ROLE="$role" \
    --env INSTALLER_ENROLLMENT_OUTPUT_FILE=/enrollment-output/enrollment.json \
    "$RP_CFG_API_IMAGE" sh -ec 'export DATABASE_URL="$(cat /run/secrets/rp_database_url)"; exec node dist/scripts/issue-installer-enrollment.js' >/dev/null || return 1
  timeout=60; elapsed=0
  while (( elapsed < timeout )); do
    state="$(docker service ps --format '{{.CurrentState}}' "$service_name" | head -n1)"
    case "$state" in
      Complete*) break ;;
      Failed*|Rejected*) docker service logs "$service_name" >&2 || true; docker service rm "$service_name" >/dev/null; return 1 ;;
    esac
    sleep 1; elapsed=$((elapsed+1))
  done
  docker service rm "$service_name" >/dev/null || true
  [[ -r "${output_file}.token" && -r "${output_file}.role" && -r "${output_file}.expires-at" ]] || return 1
  rp_write_join_bundle "$output_bundle" \
    "$(tr -d '\r\n' <"${output_file}.role")" \
    "$(tr -d '\r\n' <"${output_file}.token")" \
    "$(tr -d '\r\n' <"${output_file}.expires-at")" \
    "$enrollment_endpoint" "$pin"
  rm -rf "$workdir"; trap - RETURN
}

rp_redeem_join_bundle() {
  local bundle="$1" role token endpoint pin response join_role join_token manager_endpoint nfs_server cluster_id cluster_cidr node_id ssh_port control_plane ingress completion
  command -v jq >/dev/null 2>&1 || { printf 'jq is required for node enrollment.\n' >&2; return 1; }
  role="$(rp_bundle_value "$bundle" RP_ENROLLMENT_ROLE)" || return 1
  token="$(rp_bundle_value "$bundle" RP_ENROLLMENT_TOKEN)" || return 1
  endpoint="$(rp_bundle_value "$bundle" RP_ENROLLMENT_ENDPOINT)" || return 1
  pin="$(rp_bundle_value "$bundle" RP_ENROLLMENT_PIN)" || return 1
  rp_validate_enrollment_role "$role" || return 1
  response="$(mktemp /tmp/resourceportal-enrollment-response.XXXXXX.json)" || return 1
  chmod 0600 "$response"; trap 'rm -f "${response:-}"; trap - RETURN' RETURN
  curl --fail --silent --show-error --insecure \
    --pinnedpubkey "$pin" \
    -H 'content-type: application/json' \
    --data-binary "{\"token\":\"${token}\",\"role\":\"${role}\"}" \
    "${endpoint}/installer/enrollment/redeem" >"$response" || return 1
  join_role="$(jq -er '.role' "$response")" || return 1
  [[ "$join_role" == "$role" ]] || return 1
  join_token="$(jq -er '.joinToken' "$response")" || return 1
  manager_endpoint="$(jq -er '.managerEndpoint' "$response")" || return 1
  nfs_server="$(jq -er '.nfsServerAddress' "$response")" || return 1
  cluster_id="$(jq -er '.clusterId' "$response")" || return 1
  cluster_cidr="$(jq -er '.clusterCidr' "$response")" || return 1

  control_plane="${RP_JOIN_CONTROL_PLANE:-false}"
  ingress="${RP_JOIN_INGRESS:-false}"
  if [[ "$role" == "worker" ]]; then control_plane=false; ingress=false; fi
  ssh_port="$(rp_detect_ssh_port)" || return 1
  rp_configure_ufw "$ssh_port" "$cluster_cidr" "$ingress" || return 1

  rp_join_swarm_for_enrollment "$role" "$join_token" "$manager_endpoint" "$cluster_id" || return 1
  rp_mount_runtime_namespace nfs volumes "$nfs_server" || return 1
  if [[ "$role" == "manager" ]]; then
    rp_mount_runtime_namespace nfs secrets "$nfs_server" || return 1
    rp_mount_runtime_namespace nfs platform "$nfs_server" || return 1
  fi

  node_id="$(docker info --format '{{.Swarm.NodeID}}')" || return 1
  completion="$(mktemp /tmp/resourceportal-enrollment-complete.XXXXXX.json)" || return 1
  chmod 0600 "$completion"
  if ! curl --fail --silent --show-error --insecure \
    --pinnedpubkey "$pin" \
    -H 'content-type: application/json' \
    --data-binary "{\"token\":\"${token}\",\"role\":\"${role}\",\"nodeId\":\"${node_id}\",\"controlPlane\":${control_plane},\"ingress\":${ingress}}" \
    "${endpoint}/installer/enrollment/complete" >"$completion"; then
    rm -f "$completion"; return 1
  fi
  jq -e '.status == "completed" and (.role == "worker" or .role == "manager")' "$completion" >/dev/null || { rm -f "$completion"; return 1; }
  rm -f "$completion" "$response"; trap - RETURN
}
