/** Global Swarm probe: every eligible node must read the SAME NFS markers.
 * Two-phase acknowledgement prevents one node deleting markers while another
 * is still validating them. The elected leader removes the nonce directory
 * once all peers have acknowledged validation.
 */
export function sharedNfsProbeCommand(nodeCount: number, nonce: string): string {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 1 || nodeCount > 1024) {
    throw new Error("Invalid remote node count");
  }
  if (!/^[a-f0-9]{12,64}$/.test(nonce)) {
    throw new Error("Invalid storage probe nonce");
  }
  return [
    "set -eu",
    // A single-node LocalFilesystem backend is valid on ext4/XFS; requiring
    // NFS there incorrectly rejects the supported Stage14 installation path.
    // For multi-node placement, local filesystem fallback is forbidden.
    ...(nodeCount > 1
      ? [`awk '$2 == "/probe" && $3 ~ /^nfs(4)?$/ { ok=1 } END { exit !ok }' /proc/mounts || { echo StorageProbeNotNfs >&2; exit 11; }`]
      : []),
    `dir=/probe/.rp-shared-probe-${nonce}`,
    "case \"$HOSTNAME\" in *[!a-zA-Z0-9._-]*|'') echo StorageProbeInvalidHostname >&2; exit 15 ;; esac",
    "if [ -L \"$dir\" ]; then echo StorageProbeUnsafeDirectory >&2; exit 16; fi",
    "mkdir -p \"$dir/markers\" \"$dir/acks\"",
    `printf '%s' '${nonce}' > "$dir/markers/$HOSTNAME"`,
    "attempt=0",
    "while [ \"$attempt\" -lt 60 ]; do",
    "  files=$(find \"$dir/markers\" -type f | wc -l)",
    `  if [ "$files" -ge "${nodeCount}" ]; then`,
    `    if [ "$files" -ne "${nodeCount}" ]; then echo StorageProbeCountMismatch >&2; exit 12; fi`,
    `    for marker in "$dir/markers"/*; do [ "$(cat "$marker")" = "${nonce}" ] || { echo StorageProbeMarkerMismatch >&2; exit 13; }; done`,
    "    break",
    "  fi",
    "  attempt=$((attempt+1))",
    "  sleep 1",
    "done",
    `if [ "$attempt" -ge 60 ]; then echo StorageProbeNotSharedAcrossNodes >&2; exit 14; fi`,
    "touch \"$dir/acks/$HOSTNAME\"",
    "# Only one node performs cleanup, and only after every node has validated the markers.",
    'leader=$(find "$dir/markers" -type f | LC_ALL=C sort | head -n 1)',
    'if [ "$leader" = "$dir/markers/$HOSTNAME" ]; then',
    '  attempt=0',
    '  while [ "$attempt" -lt 60 ]; do',
    '    acks=$(find "$dir/acks" -type f | wc -l)',
    `    if [ "$acks" -eq "${nodeCount}" ]; then rm -f -- "$dir/markers"/* "$dir/acks"/*; rmdir "$dir/markers" "$dir/acks" "$dir"; exit 0; fi`,
    '    attempt=$((attempt+1))',
    '    sleep 1',
    '  done',
    '  echo StorageProbeAckTimeout >&2',
    '  exit 17',
    'fi',
  ].join("\n");
}
