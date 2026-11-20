# Codex pause: isolated JAR1 verification, 15 November 2026

## Scope and checkpoints

The working branch is based on the new open core. The owner requested fixes for
`/stop`, background work and Claude/Codex switching, with per-provider sessions
retained; successful Claude selection clears the captured Codex pause. OpenClaw
work was excluded. These commits are local; no production deployment or push
was performed by this stage.

- `74ebe02`, `c233d7a`: accept the existing stop actions during Codex sleep and
  verify command boundaries.
- `c02ec02`: defer an unstarted Codex interval without advancing its next run.
- `60a1d6f`, `e0f0d72`: compare the observed pause during a Claude selection,
  preserve both conversations, and fail safely when the provider cannot be read.
- `1766680`: correct the timer conversation test observer for the previously
  accepted new-message response.
- `c38e9d8`: keep a blocked saved timer occurrence until admission or explicit
  stop; preserve ordinary Claude timer behavior and avoid replay after admission.

Old reference blob `73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11` may be read with
`git cat-file blob 73aa9e7e`. Relevant old marker/switch lines are 3785–3803,
3848–3856 and 109826–109879; old interval admission is 24757–24767; legacy
schedule and queue are 108792–108830, 110229–110247 and 111460–111475. The
stop exception, clear-on-Claude policy and durable deferral are the owner's
requested fixes, not guarantees attributed to the old implementation.

## What was run

Local isolated checks on the complete working adapter passed **165/165**. One
existing conversation test that changes the selected engine to OpenClaw was
explicitly excluded from this run. In an earlier unfiltered local menu test run,
one isolated OpenClaw scenario was accidentally executed despite the owner's
instruction; it did not touch real OpenClaw or JAR1. Three menu test failures
that expect the former edited final reply were reproduced at the earlier
baseline and are outside this pause change.

JAR1 runs the previously accepted selective release `03a69ef181c24fcc2e6345818a100b907d47e3a9`.
The isolated test tree was built from that release plus only the listed pause
and timer files from `c38e9d8fbc07b373da192f49ea6beebeeaa4d1e3`; it retained
that release's `sleep.mjs` re-export. No working-branch OpenClaw changes were
included. [Exact selected files and SHA-256](evidence/jar1-codex-pause-2026-11-15/selective-manifest.txt).
The source archive SHA-256 was
`eaa89ccdec86470aff977f0fa0f0aa7994f3b23613ab386a2ea594a5689a9854`.

The synthetic Telegram/CLI tests ran on Debian 13, Node 22.23.5, as `client`
in a transient systemd unit with `PrivateNetwork=yes`, `ProtectSystem=strict`,
`ProtectHome=read-only`, a fresh HOME/TMPDIR, and write access only to that
HOME. Installed `node_modules` was used read-only. The test tree is not the
running bot. No real credentials or actual Claude/Codex request were used.

The initial run reported **145 passed, one failed and two cancelled** among
148 reported entries. The Python writer test failed because the temporary
parent directory did not have read permission; two test files exceeded the
15-second file timeout on JAR1. The original result is preserved in
[initial TAP](evidence/jar1-codex-pause-2026-11-15/initial.tap) (one blank
line had trailing spaces removed). After changing
only the temporary directory's permissions and increasing the timeout to 90
seconds, the three affected files passed **32/32** in
[rerun TAP](evidence/jar1-codex-pause-2026-11-15/rerun.tap). Deduplicating
successful test names across the two outputs gives **164 distinct passed**.
The mixed-working-tree-only generic wake test is inapplicable to the selective
release; the OpenClaw conversation case was deliberately excluded. No separate
OpenClaw scenario was executed on JAR1.

The tested files were `legacy-timer-dispatch`, `legacy-timer-conversation`,
`autonomy-timers`, `inbox-lifecycle`, `turn-lifecycle`, `autonomy-compact-guard`,
`sleep-gate`, `codex-pause-switch`, `codex-sleep-flow`, `codex-engine-sleep`,
`codex-sleep`, `sleep-marker`, overlay `store-concurrency`, `input-boundary`
and `input-scope` (all `.test.mjs`); `--test-concurrency=1` was used.

## Boundaries

The production bot remained active with the same PID and zero restarts. Its
installed `codex-sleep.mjs`, `sleep.mjs`, `scheduler.mjs`, and the already
pending engine request matched their pre-test SHA-256 values. Engine path and
timer units remained inactive. The temporary tree and its logs are retained
under a root-only directory in `/var/tmp`; the actual bot profile and settings
were not modified by these tests.

Claude is not authorized on the current JAR1 profile, so the provider round
trip and preservation of both conversations were tested with synthetic
credentials and provider state, not a live Claude account. Presence of a
credential is not proof of a usable subscription. No production Telegram
acceptance has been performed for these changes.

A timer originally queued while Claude is selected remains an in-memory ticket
until confirmed Codex sleep promotes it to a durable pending record; a process
crash or a storage failure before promotion can still lose that occurrence.
After a durable claim has admitted a run, it is not replayed automatically.
The existing JSON writer does not provide an fsync/power-loss guarantee. A
failed durable stop write is fenced only for the lifetime of the process.
Reverting code cannot itself restore or dispatch pending fields already written
to a live `schedules.json`; inspect and resolve them before rollback.
