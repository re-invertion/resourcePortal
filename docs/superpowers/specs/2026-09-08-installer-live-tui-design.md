# ResourcePortal Production Installer — Live TUI Design

Date: 2026-09-08
Status: Approved design
Scope: Production Installer interactive UX

## Goal

Make the ResourcePortal Production Installer operate in a full-screen live TUI by default whenever it is run interactively on a real terminal.

The TUI must make installation progress, the active stage, blocking conditions, recent activity, prompts, retries and failures visible without exposing raw command noise. The installer lifecycle, checkpointing and safety rules remain authoritative and independent from presentation.

This design extends and supersedes the UI-specific parts of `2026-09-05-production-installer-v1-design.md`. The installer remains Bash-based and does not require a Python or Node runtime for its own UI.

## User experience

The default interactive experience is a persistent live dashboard with three regions:

```text
┌ ResourcePortal Production Installer ──────────────────────────────┐
│ Mode: Primary        Host: 192-168-100-100        Progress: 72% │
├ Stages ───────────────────┬ Current operation ───────────────────┤
│ ✓ preflight              │ DNS configuration                    │
│ ✓ packages               │                                      │
│ ✓ docker                 │ Required records:                    │
│ ✓ storage                │ A resource-portal.pl      109...72   │
│ ✓ firewall               │ A auth.resource-portal.pl 109...72   │
│ ✓ swarm                  │                                      │
│ ✓ nfs                    │ Checking DNS...                      │
│ ✓ release                │ resource-portal.pl       ✗ missing   │
│ ✓ secrets                │ auth.resource-portal.pl  ✗ missing   │
│ ✓ bootstrap              │                                      │
│ ✓ migrations             │ Next check in 5s                     │
│ ✓ identity               │                                      │
│ ✓ smtp                   │                                      │
│ ! dns                    │                                      │
│ ○ ingress                │                                      │
│ ○ final                  │                                      │
│ ○ enrollment             │                                      │
│ ○ persist                │                                      │
├ Recent activity ─────────────────────────────────────────────────┤
│ 19:06:12 identity completed                                      │
│ 19:06:13 smtp completed                                          │
│ 19:06:14 waiting for DNS                                         │
└──────────────────────────────────────────────────────────────────┘
```

The exact width adapts to the terminal, but the information hierarchy is fixed:

1. installation identity and overall progress at the top;
2. stage state on the left;
3. current operation and blocking detail on the right;
4. recent user-readable activity at the bottom.

## Status model

The dashboard uses the following semantic stage states:

- `✓ completed` — checkpoint exists and the stage completed successfully;
- `● running` — stage is currently executing;
- `○ pending` — stage has not started;
- `! blocked` — stage is waiting for user action or an external condition;
- `✗ failed` — stage returned failure and installation is stopped pending retry or exit.

Color may reinforce status but must never be the only indicator. Symbols and text remain authoritative for accessibility and low-color terminals.

## Progress model

Overall progress is stage-based, not time-based.

For Primary mode:

```text
progress = completed_stages / total_stages
```

The dashboard may show a rounded percentage and a visual progress bar.

A blocked or running stage does not count as completed. Resumed installations reconstruct progress from the existing checkpoint state file rather than resetting to zero.

The same principle applies to other installer modes using the ordered steps relevant to that mode.

## TUI dependency

### Standard dependency

The interactive TUI uses Charmbracelet `gum` as an installer-managed dependency.

Initial pinned version:

```text
gum v0.17.0
```

The installer must never fetch `gum@latest` or silently upgrade the TUI dependency. Changing the pinned version requires an explicit installer code change and normal CI verification.

### Installation and verification

When an interactive TTY is detected and TUI mode is enabled:

1. detect whether the pinned `gum` version is already available;
2. if not, download the release artifact matching the supported Linux architecture;
3. verify the downloaded artifact against a checksum pinned in installer source;
4. install the verified binary in an installer-managed location;
5. start the live TUI.

The automatic `gum` bootstrap supports Linux `amd64/x86_64` and `arm64/aarch64` initially. On another architecture, an already-installed compatible `gum` may be used; otherwise interactive execution falls back to text mode without changing ResourcePortal's broader platform support. The TUI bootstrap must fail closed on checksum mismatch.

Pinned release artifact checksums for `gum v0.17.0` are:

```text
Linux x86_64  69ee169bd6387331928864e94d47ed01ef649fbfe875baed1bbf27b5377a6fdb
Linux arm64   b0b9ed95cbf7c8b7073f17b9591811f5c001e33c7cfd066ca83ce8a07c576f9c
```

These values are part of installer source/configuration and are covered by tests.

The TUI dependency bootstrap must not require Python, Node or Go on the target host.

### Fallback

If `gum` cannot be downloaded or initialized for a non-security reason, interactive installation falls back to the text UI and clearly reports that the enhanced TUI is unavailable.

A checksum mismatch or integrity-validation failure is not a normal fallback condition. It is a security failure and must stop installation.

## UI mode selection

The installer has two presentation modes:

- `tui` — default for interactive execution on a real TTY;
- `text` — deterministic line-oriented mode for non-interactive execution, CI, redirected output and environments where TUI cannot run.

`--non-interactive` always disables the live dashboard.

The TUI layer must not emit ANSI cursor-control sequences when stdout/stderr are not attached to an interactive terminal.

The text mode remains a first-class supported path and is not treated as an error state.

## Module boundaries

### `scripts/installer/ui.sh`

Responsibilities:

- UI backend selection;
- `gum` bootstrap and integrity validation;
- text fallback selection;
- user input, password, choice and confirmation primitives;
- terminal capability checks;
- presentation-mode setup and teardown.

Existing `rp_ui_*` call sites remain the public prompt abstraction. Their implementation changes from `dialog`/`whiptail` preference to `gum` preference with text fallback.

### `scripts/installer/dashboard.sh`

New module responsible only for live dashboard presentation.

Responsibilities:

- render the full-screen dashboard;
- calculate stage presentation state;
- display overall progress;
- display the current operation;
- display blocked-state detail;
- maintain a bounded recent-activity buffer;
- render failure and completion screens;
- restore terminal state on exit or interruption.

The dashboard must not perform installation mutations itself.

### `scripts/installer/lifecycle.sh`

Lifecycle remains responsible for execution and checkpoint semantics.

It emits semantic UI events but does not know how those events are rendered.

Required event classes:

```text
phase_started
phase_completed
phase_failed
phase_blocked
phase_unblocked
operation_started
operation_updated
activity
```

The event transport is an internal Bash function interface, not an external message bus.

### `scripts/installer/common.sh`

Logging remains authoritative here.

Full diagnostic output continues to be written to:

```text
/var/log/resourceportal/installer.log
```

The dashboard receives only sanitized, user-readable activity messages and never replaces the persistent log.

## Event contract

The lifecycle calls a small stable event interface such as:

```text
rp_ui_event <event> <scope> <message>
```

Examples:

```text
rp_ui_event phase_started migrations "Applying database migrations"
rp_ui_event operation_updated dns "resource-portal.pl: missing"
rp_ui_event phase_blocked dns "Waiting for required DNS A records"
rp_ui_event phase_completed identity "Identity bootstrap completed"
```

In TUI mode the event updates dashboard state and triggers a redraw.

In text mode the same event produces concise line-oriented output where appropriate.

The installation function must not branch on visual details such as colors, panel coordinates or spinner frames.

## Long-running operations

Long-running work uses explicit operation status instead of dumping command output over the dashboard.

Examples include:

- package installation;
- Docker image pull;
- Swarm service readiness;
- migrations;
- ZITADEL bootstrap;
- DNS propagation wait;
- Traefik/ACME certificate readiness;
- final service rollout.

The right-side panel shows a concise human-readable operation label and may display a `gum` spinner or progress indicator.

Raw stdout/stderr from the underlying command is redirected to the installer log unless the command output is explicitly needed for a user prompt.

## Blocking conditions

A blocked stage is distinct from a failed stage.

Examples:

- waiting for required DNS records;
- waiting for an explicit destructive-storage confirmation;
- waiting for a required user-supplied value;
- waiting for an external condition that has no deterministic local mutation.

The stage displays `! blocked`, the right-side panel explains exactly what is required, and the installer remains on the same stage.

### DNS example

The DNS gate displays at minimum:

```text
Required DNS records
A  resource-portal.pl        109.206.199.72
A  auth.resource-portal.pl   109.206.199.72

Current status
resource-portal.pl        missing
 auth.resource-portal.pl  203.0.113.10 (wrong)

Next check in 5s
```

The stage remains blocked until all required domains match the configured ingress address. Only then may it emit `phase_unblocked` and complete its checkpoint.

## Prompts and forms

Interactive prompts use `gum` components through the existing `rp_ui_*` abstraction.

Required primitives:

- input;
- password input;
- single choice;
- confirmation;
- destructive confirmation with explicit typed value where current safety rules require it.

When a prompt opens, the dashboard may temporarily yield the active terminal area to the prompt. After the prompt completes, the dashboard is redrawn from authoritative lifecycle/checkpoint state.

Passwords and secret values must never enter recent activity, dashboard state, persistent UI state or logs.

## Failure UX

A failed stage must leave the terminal in a usable state and show a failure screen containing:

- failed stage name;
- concise error summary;
- path to the full installer log;
- available actions.

Required actions:

```text
Retry
View details
Exit
```

### Retry

Retry reruns the failed stage using existing checkpoint semantics. Completed prior stages are not rerun unless their current lifecycle rules explicitly require revalidation.

### View details

`View details` shows a bounded tail of the installer log inside the TUI without printing secrets and without leaving the installer process.

It is a diagnostic view only. Returning from it restores the failure screen.

### Exit

Exit terminates cleanly without adding a successful checkpoint for the failed stage.

## Interrupt handling

`Ctrl+C`, TERM and normal exit must restore terminal state before the process terminates.

The cleanup handler must restore at minimum:

- cursor visibility;
- terminal echo/input behavior;
- screen/cursor mode used by the dashboard.

An interruption must not mark the active stage as completed.

Persistent installer state remains the source of truth for the next resume.

## Recent activity

The dashboard keeps only a bounded in-memory activity list, for example the most recent 5–10 user-readable events depending on terminal height.

Activity entries are summaries such as:

```text
Docker 29.8.0 validated
Swarm initialized
ZITADEL ready
Waiting for DNS
```

This buffer is presentation-only and is not a replacement for the full log.

Sensitive values are prohibited from activity messages.

## Logging

`/var/log/resourceportal/installer.log` remains the canonical detailed log.

The log records:

- phase transitions;
- command failures;
- sanitized diagnostics;
- enough command output to investigate failures.

The log must continue to exclude passwords, master keys, raw enrollment tokens, Swarm join tokens, SMTP credentials, session secrets and private keys.

TUI redraw sequences must never be written into the log.

## Startup and bootstrap UX

There is a short pre-dashboard bootstrap period because `gum` may not yet exist and an HTTP download client may not yet be installed.

During that period the installer uses minimal line-oriented output for:

1. root/preflight checks required before UI bootstrap;
2. detection of an existing compatible `gum`;
3. if a download client is already available, `gum` download/checksum verification;
4. otherwise the normal package-preparation step required to obtain `curl`, followed immediately by `gum` bootstrap;
5. TUI initialization.

As soon as the verified TUI dependency is available, the installer switches to the dashboard and reconstructs current progress from persisted state. Package installation may therefore be the only normal Primary stage rendered in text mode on a minimal fresh host.

This bootstrap output must be concise and deterministic.

## Completion screen

A successful interactive installation ends with a TUI summary containing at minimum:

- ResourcePortal installation status;
- release version;
- primary Web URL;
- ZITADEL/auth URL;
- control-plane service health summary;
- enrollment readiness/status;
- installer log path.

Secret credentials are never printed on the completion screen.

If SMTP was deferred or another explicitly optional capability remains deferred, the completion screen reports that fact without treating the installation as failed.

## Mode coverage

The TUI architecture applies to all installer modes:

- Primary install/resume;
- Add Swarm Node;
- Upgrade;
- Reconfigure;
- Repair / Diagnostics where interactivity is used.

Primary mode receives the full stage dashboard first because it has the longest lifecycle. Other modes reuse the same event and dashboard primitives with mode-specific ordered steps.

Read-only diagnostics may use a dashboard/list presentation, but diagnostic content and repair separation remain unchanged.

## Compatibility and migration

Existing installation state remains compatible.

The TUI does not introduce a new source of truth for lifecycle state. It derives completed stages from existing state files and current mode configuration.

Existing `/etc/resourceportal/installer.conf`, `/var/lib/resourceportal/installer-state` and `/var/log/resourceportal/installer.log` semantics remain unchanged except for new optional non-secret UI configuration keys if later needed.

A server installed before this TUI change can resume with the new installer and immediately display its existing completed checkpoints correctly.

## Security

The TUI must preserve existing installer security properties:

- no secrets in process-visible command arguments where avoidable;
- no secret values in dashboard state or activity;
- no secret values in logs;
- checksum verification before executing downloaded `gum`;
- no automatic use of an unpinned dependency version;
- no bypass of destructive-storage exact confirmation;
- no UI shortcut that can skip a lifecycle checkpoint or validation gate.

Presentation failure must never cause the installer to assume an installation action succeeded.

## Testing strategy

### Unit and shell tests

Add tests for:

- TTY detection and mode selection;
- non-TTY selection of text mode;
- `--non-interactive` disabling TUI;
- pinned `gum` version selection;
- checksum success and mismatch failure;
- download failure falling back to text mode;
- event-to-dashboard state transitions;
- stage percentage calculation;
- blocked vs failed semantics;
- recent-activity truncation;
- secret redaction/exclusion from activity;
- terminal cleanup trap installation;
- resume reconstruction from state file.

### Lifecycle contract tests

Existing installer lifecycle tests must assert that phase behavior remains independent of TUI rendering.

Tests must prove that:

- stage checkpoints are unchanged;
- a blocked stage cannot advance;
- failure does not create a checkpoint;
- retry preserves prior completed stages;
- text mode continues to run the same lifecycle.

### Rendering tests

Dashboard rendering tests should validate semantic content, not brittle exact ANSI byte sequences.

Test stable facts such as:

- completed/running/pending/blocked/failed markers;
- current operation text;
- progress percentage;
- recent activity entries;
- failure actions;
- completion summary fields.

### Integration tests

CI must cover at minimum:

1. interactive-like TTY harness with `gum` available;
2. non-TTY run using text fallback;
3. simulated `gum` download failure;
4. simulated checksum mismatch;
5. Primary resume from a partially completed state;
6. blocked DNS stage followed by successful propagation;
7. failure screen and retry path.

Existing full installer, federation and Real Swarm workflows remain required before merge.

## Rollout

Implementation should proceed incrementally while preserving a working text path:

1. introduce UI event API with text rendering;
2. add `gum` bootstrap and backend selection;
3. add dashboard state model and renderer;
4. integrate Primary phase transitions;
5. integrate operation updates and blocked states;
6. migrate prompts from dialog/whiptail to `gum` through `rp_ui_*`;
7. add failure/retry/details flow;
8. add completion summary;
9. extend reusable dashboard primitives to the other installer modes;
10. remove obsolete dialog/whiptail-specific code only after equivalent behavior is covered by tests.

At every step, non-interactive and text execution must remain functional.

## Non-goals

This work does not:

- rewrite the installer in Go, Python, Node or another language;
- change ResourcePortal service architecture;
- change storage, Swarm, identity, DNS or ingress semantics;
- replace the installer checkpoint state with a UI-specific state database;
- add a browser-based installer;
- make `gum` a runtime dependency of ResourcePortal services;
- allow the TUI to skip validation or safety gates;
- expose raw secrets for convenience.

## Acceptance criteria

The design is implemented when all of the following are true:

1. Interactive Primary installation opens the live dashboard by default after the minimal TUI bootstrap.
2. The dashboard continuously shows stage states, overall progress, current operation and recent activity.
3. Blocking stages such as DNS display as blocked and cannot advance until their condition succeeds.
4. Interactive prompts use `gum` through the shared UI abstraction.
5. Long-running command noise no longer corrupts the dashboard and remains available in the canonical log.
6. Failures provide `Retry`, `View details` and `Exit` without corrupting terminal state.
7. `Ctrl+C` restores the terminal and preserves correct checkpoint semantics.
8. Resume reconstructs completed stages from the existing installer state.
9. Non-TTY and `--non-interactive` execution use clean text output with no dashboard escape sequences.
10. `gum` is pinned, checksum-verified and never fetched as `latest`.
11. A normal `gum` availability/download failure can fall back to text mode, while checksum mismatch stops installation.
12. Full installer tests, CI, federation integration and Real Swarm integration pass before merge.
