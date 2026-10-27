/** Gate heartbeat runs at 30s plus command/network latency, while worker polls every 10s.
 * A bounded 15s aggregation margin prevents phase-dependent loss of otherwise
 * authenticated evidence. Source identity/revision and dataplane checks still apply.
 */
export const REMOTE_LAN_PROOF_MAX_AGE_MS = 45_000;
