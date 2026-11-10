#!/usr/bin/env python3
"""RP Gate v4 authorization lease.

Only root operates this private local state. This is NOT a DHCP lease.
CLOCK_BOOTTIME and boot ID prevent wall-clock rollback or reboot extension.
No grant is restored after agent restart: the calling agent clears this file
and revokes old owned forwarding before its first authenticated heartbeat.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

STATE_DIR = Path("/run/resourceportal-gate")
LEASE_FILE = STATE_DIR / "authorization.json"
GATE_STATE = Path("/etc/resourceportal-gate/state.json")
L2_STATE = Path("/etc/resourceportal-gate/lan-state.json")
LAN_AGENT = "/usr/local/sbin/resourceportal-gate-lan.py"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
MAX_TTL_SECONDS = 600
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
NONCE = re.compile(r"^[0-9a-f]{64}$")
MAC = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", re.I)


def boot_time():
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def boot_id():
    return BOOT_ID.read_text(encoding="ascii").strip()


def clear():
    LEASE_FILE.unlink(missing_ok=True)


def store(obj):
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    temp = STATE_DIR / ("authorization-" + str(os.getpid()) + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as fd:
            os.fchmod(fd.fileno(), 0o600)
            json.dump(obj, fd, sort_keys=True)
            fd.flush()
            os.fsync(fd.fileno())
        os.replace(temp, LEASE_FILE)
    finally:
        temp.unlink(missing_ok=True)


def read():
    try:
        if LEASE_FILE.is_symlink() or LEASE_FILE.stat().st_size > 16000:
            return None
        with LEASE_FILE.open(encoding="utf-8") as fd:
            state = json.load(fd)
        if not isinstance(state, dict) or state.get("bootId") != boot_id() or \
                type(state.get("deadline")) not in (int, float) or \
                not 0 < state["deadline"] - boot_time() <= MAX_TTL_SECONDS or \
                not isinstance(state.get("grants"), list) or not state["grants"]:
            return None
        # A lease is valid only for the EXACT locally applied revision and
        # application identity; a newer server policy cannot inherit it.
        local = json.loads(L2_STATE.read_text(encoding="utf-8"))
        if (local.get("gateId") != state.get("gateId") or
                local.get("tenantId") != state.get("tenantId")):
            return None
        attached = local.get("attachments")
        if not isinstance(attached, dict) or len(attached) != len(state["grants"]):
            return None
        for item in state["grants"]:
            if not isinstance(item, dict):
                return None
            physical = attached.get(item.get("attachmentId"))
            if not isinstance(physical, dict) or any(
                physical.get(field) != item.get(field)
                for field in ("singleAppId", "networkId", "configurationRevision", "macAddress")
            ):
                return None
        return state
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def renew(response, nonce):
    if not NONCE.fullmatch(nonce):
        raise ValueError("Invalid heartbeat challenge")
    lease = response.get("authorizationLease")
    config = json.loads(GATE_STATE.read_text(encoding="utf-8"))
    if not isinstance(lease, dict) or lease.get("protocol") != 1 or \
            lease.get("nonce") != nonce or \
            lease.get("gateId") != config.get("gateId") or \
            lease.get("tenantId") != response.get("tenantId"):
        raise ValueError("Untrusted authorization lease scope or nonce")
    ttl = lease.get("ttlSeconds")
    if type(ttl) is not int or not 1 <= ttl <= MAX_TTL_SECONDS:
        raise ValueError("Untrusted authorization lease duration")
    grants = lease.get("grants")
    expected = response.get("lanAttachments")
    if not isinstance(grants, list) or not isinstance(expected, list) or \
            len(grants) > 64 or len(expected) > 64:
        raise ValueError("Invalid authorization lease grants")
    approved = {a.get("id"): a for a in expected if isinstance(a, dict)}
    if len(approved) != len(expected) or response.get("gateId") != config.get("gateId"):
        raise ValueError("Invalid desired attachment identity")
    seen = set()
    for item in grants:
        if not isinstance(item, dict):
            raise ValueError("Invalid grant")
        aid = item.get("attachmentId")
        policy = approved.get(aid)
        if not isinstance(aid, str) or not UUID.fullmatch(aid) or aid in seen or not policy:
            raise ValueError("Duplicate or unexpected attachment lease")
        if item.get("gateId") != config["gateId"] or \
                item.get("tenantId") != response.get("tenantId") or \
                item.get("networkId") != policy.get("networkId") or \
                item.get("singleAppId") != policy.get("singleAppId") or \
                item.get("macAddress") != policy.get("macAddress") or \
                item.get("configurationRevision") != policy.get("configurationRevision") or \
                policy.get("status") != "Active" or \
                type(item.get("configurationRevision")) is not int or \
                not item["configurationRevision"] >= 1 or \
                not isinstance(item.get("macAddress"), str) or not MAC.fullmatch(item["macAddress"]):
            raise ValueError("Grant attempts to alter an authorized policy")
        seen.add(aid)
    # No offline forwarding is authorized if the API cannot verify every
    # locally applied attachment. This is conservative during mixed provisioning.
    if not expected or len(seen) != len(expected):
        clear()
        return False
    store({"protocol": 1, "bootId": boot_id(), "gateId": config["gateId"],
           "tenantId": response["tenantId"], "deadline": boot_time() + ttl,
           "grants": sorted(grants, key=lambda item: item["attachmentId"])})
    return True


def revoke():
    # Always revoke RP-owned resources, never the physical managed uplink.
    failure = None
    try:
        subprocess.run([sys.executable, LAN_AGENT, "--revoke-all"],
                       timeout=20, check=True, stdout=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        failure = exc
    # The RP-owned WireGuard interface must be torn down even if bridge
    # cleanup fails. Preserve failure so the watchdog keeps retrying cleanup.
    try:
        subprocess.run(["wg-quick", "down", "rp-gate"], timeout=20,
                       check=False, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        failure = failure or exc
    if failure:
        raise failure


def watch():
    """Independent deadline monitor, not blocked by HTTP requests or sleep."""
    had_lease = False
    while True:
        current = read()
        if current:
            had_lease = True
        elif had_lease or LEASE_FILE.exists():
            # A stale/corrupted/replayed lease cannot keep forwarding enabled.
            clear()
            try:
                revoke()
                had_lease = False
            except (OSError, subprocess.SubprocessError):
                # Do not exit or forget a failed revoke; keep retrying and
                # rely on independently expiring kernel source-set entries.
                had_lease = True
        time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--renew", action="store_true")
    mode.add_argument("--valid", action="store_true")
    mode.add_argument("--clear", action="store_true")
    mode.add_argument("--watch", action="store_true")
    mode.add_argument("--status", action="store_true")
    parser.add_argument("--nonce")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Only root may use RP Gate lease manager")
    if args.renew:
        if not args.nonce:
            raise ValueError("Missing heartbeat challenge")
        if not renew(json.load(sys.stdin), args.nonce):
            sys.exit(1)
    elif args.valid:
        if read() is None:
            sys.exit(1)
    elif args.clear:
        clear()
    elif args.watch:
        watch()
    elif args.status:
        state = read()
        print(json.dumps({"state": "active" if state else "expired",
                          "remainingSeconds": max(0, int(state["deadline"] - boot_time())) if state else 0,
                          "attachmentCount": len(state["grants"]) if state else 0}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print("RP Gate authorization lease rejected: " + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
