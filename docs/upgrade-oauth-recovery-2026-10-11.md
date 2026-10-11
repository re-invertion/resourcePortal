# Upgrade failure 0.2.78 → 0.2.81: repair and recovery

## Evidence and cause
On seprd1 (192.168.100.11), updater
`resourceportal-updater-240299fa-e7eb-4a06-a3b0-5516bfa1f928` exited 1
at 2026-10-11 19:16:19 Europe/Warsaw. Its installer was embedded in the
0.2.78 API image, while its OAuth job ran the target 0.2.81 bootstrap.
The latter requires federation attestation master-key and callback settings.
The old installer supplied neither. Target 0.2.81 identity.sh already
supplies the secret, callback and organization; merely publishing it did
not cause the old Worker to run it.

Checkpoint: manual-recovery-required, lastStep MCP OAuth reconciliation.
API, Worker and DR were intentionally quiesced; both PostgreSQL databases
and ZITADEL had already rolled forward. RP migrations follow this step in
the source installer, but recovery must also prove the RP database migration
names and SQL checksums equal the source image. ZITADEL may have changed its
own schema. Never infer that restoring all old images is safe.

The official 0.2.81 manifest has rollbackPolicy none. Preserve this rule.
A generic rollback, scaling up the old API, deleting state.json, or retrying
the original failed updater is not the recovery procedure.

## Permanent repair
The Worker retains a durable source-image supervisor, which verifies the
canonical manifest version, publisher allowlist and signed official
GitHub workflow provenance. It then creates a separately named installer
from the target API digest, copying exactly the verified manifest bytes.
All privileged installer mutations run inside that target image.
Failure retains the target container and logs and propagates its exit code.

The target installer checks management metadata, nonempty PAT, instance
hostname and the rp_encryption_key secret reference before quiescing clients.
It also verifies manifest provenance in the direct apply entry point.
No key material is exported in Docker arguments or diagnostics.
Checkpoint runtimeStage records quiesce, database rollout, ZITADEL, OAuth,
RP migration start and target health. Failed checkpoints remain fail-closed.

## Operator recovery for .11
Review the patch and all recovery tests before executing production recovery.
Use a complete reviewed checkout or the supplied recovery bundle; the entry
script loads its sibling installer libraries. Requirements: root on the
Primary manager, Docker, Bash, curl, jq, tar, sha256sum, cmp, flock and GitHub
CLI with `gh attestation verify`. On the observed .11, gh was absent.
Install the verifier through a trusted package source before apply.
Do not suppress signature verification.

Read-only plan:
```sh
sudo bash scripts/upgrade-recovery-from-0.2.78.sh --plan
```

After the dry run and independent test evidence have been reviewed:
```sh
sudo bash scripts/upgrade-recovery-from-0.2.78.sh --apply --confirm 0.2.78:0.2.81
```

The plan reads the recorded failed updater, installed config, checkpoint,
Swarm state, source migration inventory and database migration metadata.
It downloads the official target manifest into a temporary directory.
It changes no services, version metadata or checkpoints.

Apply revalidates under locks, verifies signed manifest provenance, then
creates a root-only backup in /var/backups/resourceportal/oauth-recovery-*:
both custom PostgreSQL dumps and their restore listings, global roles,
host config/installer state, encrypted secret store, target manifest, migration
inventory and original failure log. Checksums and pg_restore --list must pass.
These are backups of the current partially upgraded state, not a claim to
reconstruct the pre-upgrade state. Preserve any earlier pre-upgrade backups.

Only after these checks does recovery copy the original complete checkpoint
to the backup while retaining the active unresolved state.json. Recovery
runs the verified 0.2.81 image with a reviewed, narrow checkpoint adapter
appended to its installer upgrade library. This adapter replaces only
checkpoint preparation: after target preflight, it acquires the shared
journal lock, verifies the exact original state hash and checksummed backup,
and atomically marks the recovery attempt prepared. Source snapshots remain
unchanged. Both containers bind the host installer lock directory.
A failure to start or pass preflight leaves the original failure guard active;
concurrent and replayed takeover is refused. The original checkpoint is
neither discarded nor marked complete. The repaired target
bootstrap reconciles OAuth idempotently and proceeds through RP migrations,
deployment and HTTPS health checks.

The script refuses other source/target versions, another failure step,
checkpoint/config/manifest changes, unexpected database images, active
updaters, running old clients, unhealthy/nonlocal database tasks, source
migration checksum drift and incomplete backups. A second apply after
success is refused by the source-version guard; it does not replay migrations.

If apply fails, retain the backup, both updater logs and the new active
checkpoint. Do not repeat blindly, downgrade PostgreSQL/ZITADEL, or reset
installer-state. Diagnose the new lastStep/runtimeStage separately.

Completion requires installed version 0.2.81, completed checkpoint, all
control-plane replicas, API readiness/version, a live Worker heartbeat, Web
and OIDC discovery. An operator must additionally verify interactive OIDC
and MCP authorization. Docker 1/1 alone is not application health.

## Validation record
Record exact commands, SHA, result and any limitations in the PR.
The tests use isolated synthetic secrets; no production key material is
needed. Do not mark this incident resolved merely because unit tests pass.
A real isolated Swarm run and a separately authorized production apply are
distinct gates. Recovery never bypasses protected PR/Merge Queue delivery.

### Verified on 2026-10-11
- Approved source: ba663bdc84be26c1b423788271626f18440a68e2 (v0.2.81).
- Complete changed-path Fast Fix run: identity, installer, platform-release,
  upgrade-recovery and workflow profiles; exit 0. New regressions: 27/27.
  Workflow tests: 47/47; dependency audit: zero vulnerabilities; API build: exit 0.
- Review found and corrected premature active-journal removal and unshared
  installer locks. Added real flock contention, takeover/replay, authorization
  hash, backup corruption and Docker startup regressions. Re-review reported
  no remaining Critical/Important findings.
- Disposable Docker 27 Swarm on .200 (overlay2, no production mounts/ports):
  actual 0.2.81 bootstrap with old installer parameters reproduced the exact
  missing federation secret/callback failure. Target parameters completed,
  including a second reconciliation.
- Actual pinned 0.2.78 API image migrated a synthetic PostgreSQL database.
  Custom backup restored into a separate database with identical source
  migration inventory; pinned 0.2.81 migration and repeat both completed.
- The published 0.2.81 image's real GitHub CLI verified the official signed
  release manifest against main and the official release workflow.
- Read-only --plan on seprd1 .11: exit 0. Checkpoint/config/images and actual
  source migration names/checksums passed. GitHub CLI is absent there.
  Production apply, production service restart and merge were not performed.

Scope: the isolated test covers actual Swarm OAuth jobs, published images,
Prisma upgrade, backup restoration and provenance. It does not run a complete
fresh Primary installation, storage-device provisioning or browser login.
Production completion still requires separately authorized apply and the
operator health/OIDC/MCP checks above.
