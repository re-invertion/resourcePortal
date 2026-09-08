# ResourcePortal Production Installer Live TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ResourcePortal Production Installer use a live `gum`-based dashboard by default on interactive TTYs while preserving the existing Bash lifecycle, checkpoints, security properties and deterministic text/non-interactive mode.

**Architecture:** Keep installation logic independent from presentation. `lifecycle.sh` emits semantic events through `rp_ui_event`; `ui.sh` selects/bootstraps `gum` or text mode and owns prompt primitives; new `dashboard.sh` stores transient presentation state and renders the live dashboard. Persistent lifecycle state remains in the existing installer state files and detailed logs remain in `/var/log/resourceportal/installer.log`.

**Tech Stack:** Bash, Charmbracelet `gum` v0.17.0, standard Linux tools (`curl`, `sha256sum`, `tar`, `tput` only for terminal cleanup/capability support), existing shell test harness, GitHub Actions installer/federation/Real Swarm workflows.

**Spec:** `docs/superpowers/specs/2026-09-08-installer-live-tui-design.md`

## Global Constraints

- Interactive execution on a real TTY defaults to `tui`; non-TTY and `--non-interactive` always use `text`.
- The installer remains Bash-based and must not require Python, Node or Go for its UI.
- Pin exactly `gum v0.17.0`; never fetch or execute `latest`.
- Linux x86_64 checksum: `69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb`.
- Linux arm64 checksum: `b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c`.
- A normal `gum` availability/download failure may fall back to text mode; checksum mismatch must stop installation.
- No ANSI cursor-control sequences may be emitted in text/non-TTY mode.
- `/var/lib/resourceportal/installer-state` remains the lifecycle source of truth; dashboard state is memory-only.
- `/var/log/resourceportal/installer.log` remains the canonical detailed log and must never contain secrets.
- UI failures must never create lifecycle checkpoints or bypass validation/safety gates.
- Destructive-storage typed confirmation semantics remain unchanged.
- Existing full installer, CI, federation and Real Swarm workflows must pass before merge.

---

### Task 1: Introduce the presentation-mode and semantic event API

**Files:**
- Modify: `scripts/installer/ui.sh`
- Modify: `scripts/installer/common.sh`
- Modify: `resourceportal-install.sh`
- Create: `test/installer/test-ui.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `rp_log`, `rp_ui_input`, `rp_ui_password`, `rp_ui_choice`.
- Produces: `rp_ui_mode_select [non_interactive]`, `rp_ui_mode`, `rp_ui_event <event> <scope> <message>`, `rp_ui_init`, `rp_ui_cleanup`.

- [ ] **Step 1: Add failing tests for mode selection and text events**

Create `test/installer/test-ui.sh` with a small assertion harness and tests that stub terminal detection rather than requiring a real terminal:

```bash
rp_ui_has_tty(){ return 0; }
RP_NON_INTERACTIVE=false
assert_eq tui "$(rp_ui_mode_select false)" 'interactive TTY selects TUI'
assert_eq text "$(rp_ui_mode_select true)" 'non-interactive forces text mode'
rp_ui_has_tty(){ return 1; }
assert_eq text "$(rp_ui_mode_select false)" 'non-TTY selects text mode'

RP_UI_MODE=text
text_event="$(rp_ui_event phase_started migrations 'Applying database migrations')"
assert_contains "$text_event" '[migrations]' 'text event includes scope'
assert_contains "$text_event" 'Applying database migrations' 'text event includes message'
```

Also assert that `resourceportal-install.sh` parses `--non-interactive` and exports `RP_NON_INTERACTIVE=true`.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
bash test/installer/test-ui.sh
```

Expected: FAIL because `rp_ui_mode_select`, `rp_ui_event` and the CLI flag do not exist.

- [ ] **Step 3: Implement minimal mode selection and text event rendering**

In `ui.sh`, add:

```bash
RP_UI_MODE="${RP_UI_MODE:-text}"

rp_ui_has_tty() {
  [[ -t 0 && -t 1 && -t 2 ]]
}

rp_ui_mode_select() {
  local non_interactive="${1:-false}"
  if [[ "$non_interactive" == true ]] || ! rp_ui_has_tty; then
    printf 'text\n'
  else
    printf 'tui\n'
  fi
}

rp_ui_mode() { printf '%s\n' "${RP_UI_MODE:-text}"; }

rp_ui_event() {
  local event="$1" scope="$2" message="$3"
  if [[ "${RP_UI_MODE:-text}" == tui ]] && declare -F rp_dashboard_event >/dev/null; then
    rp_dashboard_event "$event" "$scope" "$message"
    return
  fi
  printf '[%s] %s\n' "$scope" "$message" >&2
}

rp_ui_init() { :; }
rp_ui_cleanup() { :; }
```

In `resourceportal-install.sh`, add `--non-interactive`, export `RP_NON_INTERACTIVE`, select the mode before dispatch, call `rp_ui_init`, and install an EXIT/INT/TERM cleanup trap that calls `rp_ui_cleanup` without changing the lifecycle return code.

- [ ] **Step 4: Add the new test to `npm run test:installer` and run it**

Modify the installer test script sequence in `package.json` so `bash test/installer/test-ui.sh` runs before lifecycle tests.

Run:

```bash
bash test/installer/test-ui.sh
npm run test:installer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/installer/ui.sh scripts/installer/common.sh resourceportal-install.sh test/installer/test-ui.sh package.json
git commit -m "feat(installer): add UI mode and event API"
```

---

### Task 2: Add pinned `gum` bootstrap with integrity verification and fallback

**Files:**
- Modify: `scripts/installer/ui.sh`
- Modify: `test/installer/test-ui.sh`
- Modify: `scripts/installer/lifecycle.sh`

**Interfaces:**
- Consumes: `rp_ui_mode_select`, `curl`, `sha256sum`, `tar`, host architecture.
- Produces: `RP_GUM_VERSION=v0.17.0`, `rp_ui_gum_asset`, `rp_ui_gum_expected_sha256`, `rp_ui_ensure_gum`, `rp_ui_try_enable_tui`, `RP_GUM_BIN`, `RP_UI_TUI_PENDING`.

- [ ] **Step 1: Add RED tests for exact artifact mapping and security behavior**

Add tests:

```bash
assert_eq 'gum_0.17.0_Linux_x86_64.tar.gz' "$(rp_ui_gum_asset amd64)" 'amd64 gum asset'
assert_eq 'gum_0.17.0_Linux_arm64.tar.gz' "$(rp_ui_gum_asset arm64)" 'arm64 gum asset'
assert_eq '69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb' \
  "$(rp_ui_gum_expected_sha256 amd64)" 'amd64 gum checksum'
assert_eq 'b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c' \
  "$(rp_ui_gum_expected_sha256 arm64)" 'arm64 gum checksum'
```

Stub `curl`, `sha256sum`, and `tar` to prove:
- download failure returns a dedicated fallback status;
- checksum mismatch returns a security-failure status;
- a valid verified artifact installs a usable binary path;
- no URL contains `latest`.

Use return code `20` for normal fallback and `21` for integrity failure so callers cannot confuse them.

- [ ] **Step 2: Run tests and verify RED**

Run `bash test/installer/test-ui.sh`.

Expected: FAIL on missing bootstrap functions.

- [ ] **Step 3: Implement pinned bootstrap**

Add constants:

```bash
RP_GUM_VERSION='v0.17.0'
RP_GUM_INSTALL_DIR='${RP_GUM_INSTALL_DIR:-/var/lib/resourceportal/installer-ui}'
```

Normalize architecture from `dpkg --print-architecture`/`uname -m` to `amd64` or `arm64`. Download from the exact GitHub release URL for `v0.17.0`, verify the archive hash before extraction, extract only the `gum` binary into an installer-managed directory, chmod `0755`, and set `RP_GUM_BIN`.

If a compatible `gum` already exists, verify `gum --version` reports `0.17.0` before using it.

Return `20` for unsupported architecture/download/init failure and `21` for checksum mismatch.

- [ ] **Step 4: Integrate two-stage startup/fallback policy into `rp_ui_init`**

Behavior:

```bash
if [[ "$RP_UI_MODE" == tui ]]; then
  if rp_ui_ensure_gum; then
    :
  else
    rc=$?
    [[ $rc -eq 21 ]] && return 1
    RP_UI_MODE=text
    RP_UI_TUI_PENDING=true
    export RP_UI_MODE RP_UI_TUI_PENDING
    rp_log WARN 'Enhanced TUI unavailable during bootstrap; using text mode until prerequisites are available.'
  fi
fi
```

If `curl`/download prerequisites are missing before Primary `packages`, set `RP_UI_TUI_PENDING=true` rather than permanently disabling TUI. For Primary mode, restructure `rp_primary_install` so `preflight` and `packages` run before `rp_collect_primary_config`; immediately after those two checkpointed phases, call `rp_ui_try_enable_tui`, then collect the remaining interactive configuration. This preserves the existing phase order/checkpoints while ensuring a minimal fresh host gets `curl` before configuration prompts and enters TUI as early as the approved spec requires. On resume, completed `preflight`/`packages` are skipped normally and `rp_ui_try_enable_tui` still runs before prompts. A genuine download/init failure after prerequisites exist may remain in text mode; checksum mismatch still returns hard failure.

Do not install `whiptail` solely for the new UI. Keep existing package behavior until prompt migration is complete in Task 7.

- [ ] **Step 5: Test fresh-host promotion after packages and config ordering**

Add a lifecycle test where the first UI initialization has no `curl`. Record call order and assert `preflight` → `packages` → `rp_ui_try_enable_tui` → `rp_collect_primary_config`. Then let `rp_ui_try_enable_tui` see a verified fake `gum` and assert later Primary phases render through the dashboard. Add the resume variant with `preflight` and `packages` already checkpointed and prove configuration still happens after the TUI promotion attempt. Also assert `--non-interactive` never promotes to TUI.

- [ ] **Step 6: Run tests**

```bash
bash test/installer/test-ui.sh
npm run test:installer
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/installer/ui.sh scripts/installer/lifecycle.sh test/installer/test-ui.sh
git commit -m "feat(installer): bootstrap pinned gum TUI"
```

---

### Task 3: Build dashboard state model and semantic renderer

**Files:**
- Create: `scripts/installer/dashboard.sh`
- Modify: `resourceportal-install.sh`
- Create: `test/installer/test-dashboard.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: ordered phase list from `rp_primary_phase_names`, state file path, semantic events.
- Produces: `rp_dashboard_init <mode> <state_file>`, `rp_dashboard_event <event> <scope> <message>`, `rp_dashboard_progress_percent`, `rp_dashboard_render_text`, `rp_dashboard_activity_add`.

- [ ] **Step 1: Write failing state-transition tests**

Test a fixed phase list `preflight packages dns ingress` and state file containing `preflight\npackages\n`:

```bash
rp_dashboard_init primary "$state"
assert_eq 50 "$(rp_dashboard_progress_percent)" 'resume progress is checkpoint based'
rp_dashboard_event phase_started dns 'Waiting for DNS'
assert_eq running "$(rp_dashboard_phase_status dns)" 'phase_started marks running'
rp_dashboard_event phase_blocked dns 'Waiting for records'
assert_eq blocked "$(rp_dashboard_phase_status dns)" 'blocked differs from failed'
rp_dashboard_event phase_unblocked dns 'DNS ready'
assert_eq running "$(rp_dashboard_phase_status dns)" 'unblocked returns to running'
rp_dashboard_event phase_failed dns 'DNS resolver failed'
assert_eq failed "$(rp_dashboard_phase_status dns)" 'phase_failed marks failed'
```

Add activity truncation test with max 5 items and verify the oldest entry drops.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-dashboard.sh`; expect missing functions.

- [ ] **Step 3: Implement in-memory dashboard model**

Use Bash arrays/maps only:

```bash
declare -ag RP_DASHBOARD_PHASES=()
declare -Ag RP_DASHBOARD_STATUS=()
declare -ag RP_DASHBOARD_ACTIVITY=()
RP_DASHBOARD_OPERATION=''
RP_DASHBOARD_BLOCK_DETAIL=''
```

`rp_dashboard_init` reconstructs `completed` from the state file and sets remaining phases `pending`. Event handling updates only transient state; `phase_completed` must not write the lifecycle state file itself.

- [ ] **Step 4: Implement semantic text renderer for testing**

`rp_dashboard_render_text` should output stable semantic lines such as:

```text
Mode: Primary
Progress: 50%
✓ preflight
✓ packages
! dns
○ ingress
Current: Waiting for records
```

Do not test exact ANSI sequences.

- [ ] **Step 5: Wire `dashboard.sh` into entrypoint and test suite**

Source `dashboard.sh` before `lifecycle.sh`. Add `test-dashboard.sh` to `test:installer`.

Run:

```bash
bash test/installer/test-dashboard.sh
npm run test:installer
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/dashboard.sh resourceportal-install.sh test/installer/test-dashboard.sh package.json
git commit -m "feat(installer): add live dashboard state model"
```

---

### Task 4: Render the full-screen `gum` dashboard and restore terminal state

**Files:**
- Modify: `scripts/installer/dashboard.sh`
- Modify: `scripts/installer/ui.sh`
- Modify: `test/installer/test-dashboard.sh`
- Modify: `test/installer/test-ui.sh`

**Interfaces:**
- Consumes: dashboard semantic state, `$RP_GUM_BIN`, terminal width/height.
- Produces: `rp_dashboard_render`, `rp_dashboard_enter`, `rp_dashboard_leave`, cleanup-safe terminal behavior.

- [ ] **Step 1: Add RED rendering-content and cleanup tests**

Stub `RP_GUM_BIN` with a fake executable/function that records arguments. Assert render includes:
- title `ResourcePortal Production Installer`;
- mode;
- progress percentage;
- phase symbols/text;
- current operation;
- recent activity.

Stub terminal helper commands and assert `rp_dashboard_leave` requests cursor restoration and leaves the function idempotent.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-dashboard.sh`.

- [ ] **Step 3: Implement renderer**

Use `gum style` and `gum join` to build:
- top identity/progress row;
- left stage panel;
- right operation/block panel;
- bottom recent-activity panel.

Clear/redraw only in `tui` mode. Adapt width to terminal size with a minimum compact layout; when terminal width is too small for two columns, stack stage and operation panels vertically rather than failing.

- [ ] **Step 4: Implement terminal enter/leave lifecycle**

Hide cursor only after dashboard starts. Cleanup must restore cursor and reset terminal formatting on EXIT/INT/TERM. Repeated cleanup calls must succeed.

- [ ] **Step 5: Run focused and full tests**

```bash
bash test/installer/test-dashboard.sh
bash test/installer/test-ui.sh
npm run test:installer
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/dashboard.sh scripts/installer/ui.sh test/installer/test-dashboard.sh test/installer/test-ui.sh
git commit -m "feat(installer): render full-screen gum dashboard"
```

---

### Task 5: Emit lifecycle phase events without changing checkpoint semantics

**Files:**
- Modify: `scripts/installer/lifecycle.sh`
- Modify: `test/installer/test-diagnostics.sh`
- Modify: `test/installer/test-dashboard.sh`

**Interfaces:**
- Consumes: `rp_ui_event`.
- Produces: phase events from `rp_run_phase`; checkpoint behavior remains unchanged.

- [ ] **Step 1: Add failing lifecycle-event contract test**

Stub `rp_ui_event` to append `event|scope|message` to a temp file. Run one successful phase, one failed phase and a skipped completed phase. Assert:

```text
phase_started|preflight|...
phase_completed|preflight|...
phase_started|dns|...
phase_failed|dns|...
```

and assert the failed phase is absent from the state file. A skipped completed phase must not execute its command again.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-diagnostics.sh` and expect missing event assertions.

- [ ] **Step 3: Modify `rp_run_phase` minimally**

Use:

```bash
rp_ui_event phase_started "$phase" "Starting $phase"
if ! "$@"; then
  rp_log ERROR "installer phase failed: $phase"
  rp_ui_event phase_failed "$phase" "Stage failed: $phase"
  return 1
fi
rp_phase_mark_done "$state_file" "$phase"
rp_log INFO "installer phase completed: $phase"
rp_ui_event phase_completed "$phase" "Completed $phase"
```

Do not move `rp_phase_mark_done` earlier and do not let event-rendering success determine phase success.

- [ ] **Step 4: Initialize dashboard around Primary lifecycle**

At the start of `rp_primary_install`, after configuration/state path resolution, initialize dashboard from `rp_primary_phase_names` and the actual state file when TUI mode is active.

- [ ] **Step 5: Run tests**

```bash
bash test/installer/test-diagnostics.sh
bash test/installer/test-dashboard.sh
npm run test:installer
```

Expected: PASS with existing checkpoint tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/installer/lifecycle.sh test/installer/test-diagnostics.sh test/installer/test-dashboard.sh
git commit -m "feat(installer): emit lifecycle dashboard events"
```

---

### Task 6: Add operation updates and explicit blocked-state events, starting with DNS

**Files:**
- Modify: `scripts/installer/domain.sh`
- Modify: `scripts/installer/lifecycle.sh`
- Modify: `scripts/installer/control-plane.sh`
- Modify: `scripts/installer/identity.sh`
- Modify: `test/installer/test-identity-domain.sh`
- Modify: `test/installer/test-control-plane.sh`
- Modify: `test/installer/test-dashboard.sh`

**Interfaces:**
- Consumes: `rp_ui_event`.
- Produces: `operation_started`, `operation_updated`, `activity`, `phase_blocked`, `phase_unblocked` events, plus `rp_run_logged_operation <scope> <message> <command...>` for commands whose raw output must not corrupt TUI.

- [ ] **Step 1: Add RED DNS blocked-state test**

Stub resolver results across calls: missing → wrong IP → both correct. Capture events and assert:

```text
phase_blocked|dns|Waiting for required DNS A records
operation_updated|dns|resource-portal.pl: missing
operation_updated|dns|auth.resource-portal.pl: 203.0.113.10 (wrong)
phase_unblocked|dns|Required DNS records are ready
```

Assert the function does not return success before both domains are correct.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-identity-domain.sh`; expected missing blocked/update events.

- [ ] **Step 3: Instrument DNS wait**

Keep the current DNS validation semantics. On first invalid state emit `phase_blocked`, update each domain status every retry, show the required A records in the message, and emit `phase_unblocked` immediately before returning success.

- [ ] **Step 4: Add a logged-operation helper and prove output routing**

Implement `rp_run_logged_operation <scope> <message> <command...>` in `common.sh` or `ui.sh`. In TUI mode it emits `operation_started`, appends the command's stdout/stderr to `$RP_INSTALLER_LOG_FILE`, and returns the exact command status without echoing raw output to the dashboard. In text mode it preserves line-oriented visibility while still appending to the log. Add a test command that writes one line to stdout and one to stderr, then assert both lines are in the log, neither appears in TUI render output, and a non-zero exit remains non-zero. Never pass secret values through the helper's user-readable `<message>`.

- [ ] **Step 5: Instrument representative long operations**

Add concise events/helper usage around:
- migrations: `Applying database migrations`;
- ZITADEL bootstrap: `Bootstrapping identity provider`;
- Swarm readiness: `Waiting for <service> replicas`;
- ingress certificate wait: `Waiting for HTTPS certificate`;
- final rollout: `Waiting for ResourcePortal health`.

Underlying command output continues to go to the canonical log; do not place secrets or full command lines in events.

- [ ] **Step 6: Add activity sanitization tests**

Pass strings containing values from test-only variables named like passwords/tokens and assert activity functions receive only explicit safe summaries, not command output or secret payloads.

- [ ] **Step 7: Run tests and commit**

```bash
bash test/installer/test-identity-domain.sh
bash test/installer/test-control-plane.sh
bash test/installer/test-dashboard.sh
npm run test:installer
git add scripts/installer/common.sh scripts/installer/domain.sh scripts/installer/lifecycle.sh scripts/installer/control-plane.sh scripts/installer/identity.sh test/installer/test-identity-domain.sh test/installer/test-control-plane.sh test/installer/test-dashboard.sh
git commit -m "feat(installer): show live operations and blocked stages"
```

---

### Task 7: Migrate interactive prompts to `gum` through `rp_ui_*`

**Files:**
- Modify: `scripts/installer/ui.sh`
- Modify: `scripts/installer/lifecycle.sh`
- Modify: `scripts/installer/storage.sh`
- Modify: `scripts/installer/reconfigure.sh`
- Modify: `scripts/installer/repair.sh`
- Modify: `test/installer/test-ui.sh`
- Modify: `test/installer/test-core.sh`
- Modify: `test/installer/test-storage.sh`

**Interfaces:**
- Consumes: `$RP_GUM_BIN`, current `rp_ui_*` call signatures.
- Produces: gum-backed `rp_ui_message`, `rp_ui_input`, `rp_ui_password`, `rp_ui_choice`, new `rp_ui_confirm`; text fallback preserves old call-site behavior.

- [ ] **Step 1: Add failing prompt adapter tests**

Fake `gum` and assert:
- input passes title/prompt/default but outputs only the entered value;
- password uses hidden input and never echoes the value to stderr/log;
- choice returns the stable machine value, not the human label;
- confirmation returns status 0/1;
- text backend still accepts the same call signatures.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-ui.sh`.

- [ ] **Step 3: Implement gum prompt adapters**

Map:
- input → `gum input`;
- password → `gum input --password`;
- choice → `gum choose` with a stable value/label mapping maintained by the wrapper;
- confirm → `gum confirm`.

When a prompt begins, suspend/redraw dashboard cleanly; after prompt completion call `rp_dashboard_render` from authoritative current state.

- [ ] **Step 4: Preserve exact destructive confirmation**

Do not replace typed `FORMAT <device>` or `REPAIR <action>` with a yes/no prompt. They continue to use `rp_ui_input`, now gum-backed in TUI mode.

- [ ] **Step 5: Remove `dialog`/`whiptail` preference only after test parity**

Change `rp_ui_backend` to return only `gum` or `terminal/text`. Remove dialog/whiptail code paths once all current UI tests pass. Remove `whiptail` from `rp_prepare_host_packages` only after verifying no installer module calls it directly.

- [ ] **Step 7: Run tests and commit**

```bash
bash test/installer/test-ui.sh
bash test/installer/test-core.sh
bash test/installer/test-storage.sh
npm run test:installer
git add scripts/installer/ui.sh scripts/installer/lifecycle.sh scripts/installer/storage.sh scripts/installer/reconfigure.sh scripts/installer/repair.sh test/installer/test-ui.sh test/installer/test-core.sh test/installer/test-storage.sh
git commit -m "feat(installer): migrate prompts to gum"
```

---

### Task 8: Implement failure screen, details view and retry without checkpoint corruption

**Files:**
- Modify: `scripts/installer/dashboard.sh`
- Modify: `scripts/installer/lifecycle.sh`
- Modify: `scripts/installer/ui.sh`
- Modify: `test/installer/test-dashboard.sh`
- Modify: `test/installer/test-diagnostics.sh`

**Interfaces:**
- Consumes: failed phase name, canonical log path, original phase command and args.
- Produces: `rp_ui_failure_action <phase> <summary>`, `rp_dashboard_log_tail`, retry loop in `rp_run_phase` for interactive TUI only.

- [ ] **Step 1: Add RED tests for failure actions**

Stub `rp_ui_failure_action` to return `retry` once, then let the command succeed. Assert:
- failed first attempt creates no checkpoint;
- retry reruns only that phase command;
- prior completed checkpoints remain untouched;
- success after retry creates exactly one checkpoint.

Also test `exit` returns failure without checkpoint.

- [ ] **Step 2: Add RED details-view tests**

Create a temp installer log with 100 safe lines. Assert `rp_dashboard_log_tail` returns only a bounded tail (for example 40 lines) and the failure screen contains:

```text
Retry
View details
Exit
```

- [ ] **Step 3: Implement failure action UI**

In TUI mode use `gum choose` for `Retry`, `View details`, `Exit`. In text mode preserve current fail-and-return behavior; do not introduce interactive retry in non-TTY execution.

- [ ] **Step 4: Implement retry loop in `rp_run_phase`**

Structure the command execution as an attempt loop. On failure emit `phase_failed`; if TUI action is retry, change status back to running and rerun the same command. `View details` does not alter phase state and returns to the failure menu. `Exit` returns 1.

- [ ] **Step 5: Run tests and commit**

```bash
bash test/installer/test-dashboard.sh
bash test/installer/test-diagnostics.sh
npm run test:installer
git add scripts/installer/dashboard.sh scripts/installer/lifecycle.sh scripts/installer/ui.sh test/installer/test-dashboard.sh test/installer/test-diagnostics.sh
git commit -m "feat(installer): add TUI failure retry and details"
```

---

### Task 9: Add completion summary and reusable mode-level dashboard flows

**Files:**
- Modify: `scripts/installer/dashboard.sh`
- Modify: `resourceportal-install.sh`
- Modify: `scripts/installer/upgrade.sh`
- Modify: `scripts/installer/reconfigure.sh`
- Modify: `scripts/installer/diagnostics.sh`
- Modify: `scripts/installer/enrollment.sh`
- Modify: `test/installer/test-dashboard.sh`
- Modify: `test/installer/test-diagnostics.sh`
- Modify: `test/installer/test-enrollment.sh`

**Interfaces:**
- Consumes: mode, release/config state, service health summaries.
- Produces: `rp_dashboard_complete`, mode-specific ordered step sets/event usage.

- [ ] **Step 1: Add RED completion screen tests**

Assert the semantic completion render includes:
- installation status;
- release version;
- `https://$RP_CFG_DOMAIN`;
- `https://$RP_CFG_ZITADEL_DOMAIN`;
- control-plane service summary;
- enrollment status;
- `/var/log/resourceportal/installer.log`;
- SMTP deferred notice when `RP_CFG_SMTP_DEFERRED=true`.

Assert it excludes test password/token variables.

- [ ] **Step 2: Verify RED**

Run `bash test/installer/test-dashboard.sh`.

- [ ] **Step 3: Implement Primary completion summary**

Call it only after the normal Primary lifecycle returns success, so it cannot mask a failed persist/enrollment stage.

- [ ] **Step 4: Reuse event/dashboard primitives in other modes**

Wrap the exact top-level modes **Add Swarm Node**, **Upgrade ResourcePortal**, **Reconfigure Installation**, and **Repair / Diagnostics** with mode-appropriate `operation_started`, `activity`, and completion/failure rendering. Do not invent new persistent checkpoints for modes that do not currently have them.

- [ ] **Step 5: Run focused/full tests and commit**

```bash
bash test/installer/test-dashboard.sh
bash test/installer/test-diagnostics.sh
bash test/installer/test-enrollment.sh
npm run test:installer
git add scripts/installer/dashboard.sh resourceportal-install.sh scripts/installer/upgrade.sh scripts/installer/reconfigure.sh scripts/installer/diagnostics.sh scripts/installer/enrollment.sh test/installer/test-dashboard.sh test/installer/test-diagnostics.sh test/installer/test-enrollment.sh
git commit -m "feat(installer): complete TUI mode coverage"
```

---

### Task 10: Add TTY integration harness, final verification and release rollout

**Files:**
- Create: `test/installer/test-tui-integration.sh`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml` if installer tests are not already sufficient to exercise a pseudo-TTY
- Modify: installer docs only where existing user-facing installation instructions describe dialog/whiptail behavior.

**Interfaces:**
- Consumes: completed TUI implementation.
- Produces: end-to-end proof of TUI/text/fallback/resume behavior and production release readiness.

- [ ] **Step 1: Build pseudo-TTY integration harness**

Use `script(1)` or another already-available util-linux PTY mechanism in CI. Provide a fake verified `gum` binary through `RP_GUM_BIN`/test install directory so CI does not depend on live GitHub downloads for the positive TUI path.

Scenarios must cover:
1. TTY → TUI selected;
2. non-TTY → text selected with no cursor escape sequences;
3. `--non-interactive` → text selected;
4. normal gum download failure → text fallback;
5. checksum mismatch → hard failure;
6. partially completed Primary state reconstructs correct progress;
7. DNS blocked then propagated → blocked → running/completed;
8. failed phase → Retry → success.

- [ ] **Step 2: Verify RED before adding any missing integration glue**

Run:

```bash
bash test/installer/test-tui-integration.sh
```

Expected: any uncovered integration edge should fail specifically before fixing it.

- [ ] **Step 3: Add only the minimal glue required by failing scenarios**

Do not change storage/Swarm/identity/DNS semantics. Fix presentation/bootstrap/event wiring only.

- [ ] **Step 4: Run all local verification**

```bash
bash -n resourceportal-install.sh scripts/installer/*.sh
npm run test:installer
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify repository diff and secret hygiene**

Run:

```bash
git diff --check
git grep -nE 'gum@latest|/releases/latest|RP_ADMIN_PASSWORD=.*printf|RP_SMTP_PASSWORD=.*printf' -- . ':!docs/superpowers/specs/*' ':!docs/superpowers/plans/*'
```

Expected: no `latest` dependency use and no newly introduced plaintext-secret logging.

- [ ] **Step 6: Commit integration coverage**

```bash
git add test/installer/test-tui-integration.sh package.json .github/workflows/ci.yml docs
git commit -m "test(installer): cover live TUI integration"
```

- [ ] **Step 7: Push feature branch and open PR**

Push the implementation branch, open a PR referencing the approved spec and plan, then require these checks to pass for the exact final head SHA:
- CI / validate;
- Live Federation Integration;
- Real Docker Swarm Integration;
- any existing Codespaces/preview smoke triggered by installer changes.

- [ ] **Step 8: Merge only after all required checks are green**

Record final head SHA and merge commit SHA. Do not merge around a failing required integration check unless it is independently proven infrastructure-only and successfully rerun.

- [ ] **Step 9: Publish/update the production installer release artifact if release packaging requires it**

If the production installation path consumes a release/tagged installer artifact rather than `main`, run the repository's controlled release workflow. Preserve pinned immutable service image behavior; a UI-only installer change must not unnecessarily mutate application image references.

- [ ] **Step 10: Validate on `192.168.100.100` using the existing installation state**

Update the server installer to the merged commit and run interactively. Verify:
- existing checkpoints reconstruct correctly;
- current DNS stage appears `blocked` when DNS is still absent;
- required A records are shown;
- no later ingress checkpoint appears while DNS is invalid;
- terminal remains usable after Ctrl+C;
- rerunning resumes at the same unfinished stage;
- text mode can still be invoked non-interactively for diagnostics/tests.

Do not manually add phase checkpoints during this validation.
