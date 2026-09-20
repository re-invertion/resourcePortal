#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_name="rp-v022-privileged-network-smoke"
allowed_network="rp-v022-allowed-client"
denied_network="rp-v022-denied-client"
published_port="18080"
app_group_id="55555555-5555-4555-8555-555555555555"
tenant_id="66666666-6666-4666-8666-666666666666"
guard_runner="$repo_root/packages/resourceportal-api/dist/src/network-egress/egress-guard.runner.js"
guard_tmp_dir="$(mktemp -d /tmp/rp-v022-egress-guard.XXXXXX)"
# The privileged guard process creates its own files. A dedicated non-sticky
# directory avoids Linux fs.protected_regular restrictions that can prevent a
# sudo process from truncating runner-owned files directly under /tmp.
chmod 0777 "$guard_tmp_dir"
guard_log="$guard_tmp_dir/guard.log"
guard_pid_file="$guard_tmp_dir/guard.pid"

cleanup() {
  rc=$?
  set +e
  if (( rc != 0 )); then
    echo "v0.2.2 privileged networking smoke failed with rc=$rc" >&2
    if [[ -f "$guard_log" ]]; then
      echo "--- egress guard log ---" >&2
      cat "$guard_log" >&2 || true
    fi
    echo "--- internal port firewall chain ---" >&2
    sudo -n iptables -w 5 -S RP-TENANT-INTERNAL-PORTS >&2 2>/dev/null || true
    echo "--- smoke service tasks ---" >&2
    docker service ps --no-trunc "$service_name" >&2 2>/dev/null || true
    echo "--- smoke container labels ---" >&2
    container_id="$(docker ps --filter "label=resourceportal.app-group-id=$app_group_id" --format '{{.ID}}' | head -n1)"
    if [[ -n "$container_id" ]]; then
      docker inspect "$container_id" --format '{{json .Config.Labels}}' >&2 2>/dev/null || true
      docker network inspect docker_gwbridge >&2 2>/dev/null || true
    fi
  fi
  if [[ -s "$guard_pid_file" ]]; then
    sudo -n kill -TERM "$(cat "$guard_pid_file")" >/dev/null 2>&1 || true
  fi
  docker service rm "$service_name" >/dev/null 2>&1 || true
  docker network rm "$allowed_network" >/dev/null 2>&1 || true
  docker network rm "$denied_network" >/dev/null 2>&1 || true
  sudo -n bash -c "source '$repo_root/scripts/installer/firewall.sh'; rp_remove_resourceportal_egress_firewall_rules" >/dev/null 2>&1 || true
  rm -rf "$guard_tmp_dir"
  return "$rc"
}
trap cleanup EXIT

[[ "$(docker info --format '{{.Swarm.LocalNodeState}}')" == "active" ]] || {
  echo "v0.2.2 privileged networking smoke requires an active Docker Swarm" >&2
  exit 1
}
command -v sudo >/dev/null 2>&1 || { echo "sudo is required" >&2; exit 1; }
sudo -n true

if [[ ! -f "$guard_runner" ]]; then
  npm --workspace @resource-portal/api run build
fi

docker pull alpine:3.20 >/dev/null
docker pull nginx:alpine >/dev/null

docker network create --driver bridge --subnet 172.30.240.0/24 "$allowed_network" >/dev/null
docker network create --driver bridge --subnet 172.30.241.0/24 "$denied_network" >/dev/null
allowed_gateway="$(docker network inspect "$allowed_network" --format '{{(index .IPAM.Config 0).Gateway}}')"
denied_gateway="$(docker network inspect "$denied_network" --format '{{(index .IPAM.Config 0).Gateway}}')"

exposure_b64="$(node -e 'process.stdout.write(Buffer.from(JSON.stringify([{publishedPort:18080,protocol:"tcp"}])).toString("base64"))')"

docker service create \
  --name "$service_name" \
  --constraint 'node.labels.rp.node.tenant-workloads == true' \
  --container-label resourceportal.workload=tenant \
  --container-label "resourceportal.app-group-id=$app_group_id" \
  --container-label "resourceportal.tenant-id=$tenant_id" \
  --container-label "resourceportal.internal-port-exposures-b64=$exposure_b64" \
  --publish "published=$published_port,target=80,protocol=tcp,mode=host" \
  --replicas 1 \
  --detach=true \
  nginx:alpine >/dev/null

for _ in $(seq 1 60); do
  replicas="$(docker service ls --filter "name=$service_name" --format '{{.Replicas}}')"
  if [[ "$replicas" == "1/1" ]]; then
    break
  fi
  sleep 1
done
[[ "$(docker service ls --filter "name=$service_name" --format '{{.Replicas}}')" == "1/1" ]] || {
  docker service ps --no-trunc "$service_name" >&2 || true
  exit 1
}

policy_b64="$(node - "$app_group_id" <<'NODE'
const appGroupId = process.argv[2];
const policy = {
  version: 1,
  enabled: true,
  revision: 2202,
  blockedIpv4Cidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  blockedIpv6Cidrs: ["fc00::/7", "fe80::/10", "::1/128"],
  internalNetworkCidrs: ["172.30.240.0/24"],
  privilegedAppGroupIds: [appGroupId],
  rules: [],
};
process.stdout.write(Buffer.from(JSON.stringify(policy)).toString("base64"));
NODE
)"

sudo -n sh -c '
  pid_file=$1
  log_file=$2
  shift 2
  printf "%s\n" "$$" > "$pid_file"
  exec env "$@" >"$log_file" 2>&1
' sh "$guard_pid_file" "$guard_log" \
  "RESOURCEPORTAL_EGRESS_POLICY_B64=$policy_b64" \
  "EGRESS_GUARD_RECONCILE_INTERVAL_MS=250" \
  node "$guard_runner" &
guard_sudo_pid=$!

for _ in $(seq 1 40); do
  if sudo -n iptables -w 5 -S RP-TENANT-INTERNAL-PORTS >/dev/null 2>&1 \
    && grep -Fq 'Applied network policy revision=2202' "$guard_log"; then
    break
  fi
  if ! kill -0 "$guard_sudo_pid" >/dev/null 2>&1; then
    cat "$guard_log" >&2
    exit 1
  fi
  sleep 0.5
done

grep -Fq 'Applied network policy revision=2202' "$guard_log" || {
  cat "$guard_log" >&2
  exit 1
}

rules="$(sudo -n iptables -w 5 -S RP-TENANT-INTERNAL-PORTS)"
allow_rule="$(grep -F -- '-s 172.30.240.0/24 ' <<<"$rules" | grep -F -- '--ctorigdstport 18080' | grep -F -- '--ctstate DNAT' | grep -F -- '-j RETURN' || true)"
reject_rule="$(grep -F -- '--ctorigdstport 18080' <<<"$rules" | grep -F -- '--ctstate DNAT' | grep -F -- '-j REJECT' || true)"
[[ -n "$allow_rule" ]] || { echo "Trusted-CIDR RETURN rule missing" >&2; exit 1; }
[[ -n "$reject_rule" ]] || { echo "Default internal-port REJECT rule missing" >&2; exit 1; }

allowed_body="$(docker run --rm --network "$allowed_network" alpine:3.20 wget -qO- -T 5 "http://$allowed_gateway:$published_port/")"
grep -Fq 'Welcome to nginx' <<<"$allowed_body"

if docker run --rm --network "$denied_network" alpine:3.20 wget -qO- -T 5 "http://$denied_gateway:$published_port/" >/dev/null 2>&1; then
  echo "Denied client network unexpectedly reached the internal published port" >&2
  exit 1
fi

printf 'PASS: v0.2.2 privileged App Group host-mode port is reachable from trusted internal CIDR and rejected from an untrusted CIDR.\n'
