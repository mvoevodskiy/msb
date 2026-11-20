#!/bin/bash
# msb-bot-watchdog.sh — ExecStartPre guard against crash loops.
# Multi-bot aware: routes per-bot crash state via MSB_BOT_ID env var.

# Defer legacy repair without preventing the enrolled unit start guard from deciding.
BOT_ID="${MSB_BOT_ID:-}"
VERSIONS_DIR="/home/client/.msb/bot/versions"
BOT_FILE="/home/client/.msb/bot/index.js"
if [ -n "$BOT_ID" ]; then
  CRASH_LOG="/home/client/.msb/bots/${BOT_ID}/.crash-count"
  HOOKS_DIR="/home/client/.msb/bots/${BOT_ID}/agent-hooks"
  UNIT="msb-bot@${BOT_ID}.service"
else
  CRASH_LOG="/home/client/.msb/bot/.crash-count"
  HOOKS_DIR="/home/client/.msb/agent-hooks"
  UNIT="msb-bot.service"
fi
DISABLED_FLAG="${HOOKS_DIR}/_disabled"
# Auto-unmute TTL: _disabled older than this + a clean crash window → the
# watchdog lifts the mute itself (before, only regenerate-bot-env.sh removed
# it, by hand — muted boxes stayed muted forever).
DISABLED_TTL=86400
mkdir -p "$(dirname "$CRASH_LOG")" 2>/dev/null
NOW=$(date +%s)
# WP-G4: defer to the puller while it applies + health-gates (it owns the revert
# in that window — avoids fighting its rollback, R5). Marker is self-expiring:
# the puller clears it, and we treat it stale after ~3min if the puller died.
PULLER_MARKER="/home/client/.msb/.puller-applying"
if [ -f "$PULLER_MARKER" ]; then
  MARKER_AGE=$(( NOW - $(stat -c %Y "$PULLER_MARKER" 2>/dev/null || echo 0) ))
  if [ "$MARKER_AGE" -ge 0 ] && [ "$MARKER_AGE" -lt 180 ]; then
    logger -t msb-watchdog "puller applying (marker ${MARKER_AGE}s old) — deferring crash-loop rollback for ${BOT_ID:-legacy}"
    exit 0
  fi
fi
# Classify the run that JUST ended: prints "crash" or "clean". Every unit start
# used to count as a crash, so a wave of ROUTINE restarts (idle-exit 0, manual
# systemctl restart from the admin channel) muted agent-hooks and rolled back
# the shared engine on healthy boxes (2026-08-29 incident, two boxes in a day).
# Source of truth: `systemctl show` — ExecMainCode/ExecMainStatus keep the
# PREVIOUS main process exit until the new main is forked, which happens
# strictly AFTER ExecStartPre, so this read always sees the run that just
# ended. Read-only D-Bus query: works for User=client, queues no jobs.
# journald was rejected (free-text parsing, rotation, slower); a clean-exit
# marker file was rejected (the bot itself would have to write it — a crash
# before that line of code leaves no marker, and every clean exit of an OLD
# bundle that never writes one would look like a crash again).
classify_prev_exit() {
  local show code status start_us exit_us uptime
  show=$(systemctl show "$1" -p ExecMainCode -p ExecMainStatus -p ExecMainStartTimestampMonotonic -p ExecMainExitTimestampMonotonic 2>/dev/null)
  code=$(printf '%s\n' "$show" | sed -n 's/^ExecMainCode=//p')
  status=$(printf '%s\n' "$show" | sed -n 's/^ExecMainStatus=//p')
  start_us=$(printf '%s\n' "$show" | sed -n 's/^ExecMainStartTimestampMonotonic=//p')
  exit_us=$(printf '%s\n' "$show" | sed -n 's/^ExecMainExitTimestampMonotonic=//p')
  # No previous exit on record (first start after boot/provision) or the unit
  # state is unreadable — nothing to punish. Fail-open is safe: a real crash
  # loop is still backstopped by the unit's own StartLimitBurst=5/300s.
  if [ -z "$code" ] || [ "$code" = "0" ]; then echo clean; return; fi
  # The previous run lived long before exiting → a restart, not a loop member.
  if [ -n "$start_us" ] && [ -n "$exit_us" ] && [ "$exit_us" -gt "$start_us" ] 2>/dev/null; then
    uptime=$(( (exit_us - start_us) / 1000000 ))
    if [ "$uptime" -gt 600 ]; then echo clean; return; fi
  fi
  if [ "$code" = "1" ]; then
    # CLD_EXITED: 0 = routine exit (idle-exit), 143 = 128+SIGTERM (node maps a
    # caught SIGTERM to exit 143 — systemctl stop/restart). Anything else = crash.
    case "$status" in 0|143) echo clean ;; *) echo crash ;; esac
  else
    # CLD_KILLED/CLD_DUMPED: SIGTERM(15) is systemd's own stop/restart signal
    # = routine. Anything else (9=SIGKILL/OOM, 11=SIGSEGV, 6=SIGABRT) = crash.
    case "$status" in 15) echo clean ;; *) echo crash ;; esac
  fi
}
VERDICT=$(classify_prev_exit "$UNIT")
if [ "$VERDICT" = "crash" ]; then
  echo "$NOW" >> "$CRASH_LOG" 2>/dev/null
fi
COUNT=0
if [ -f "$CRASH_LOG" ]; then
  awk -v cutoff=$((NOW - 300)) '$1 >= cutoff' "$CRASH_LOG" > "${CRASH_LOG}.tmp"
  mv "${CRASH_LOG}.tmp" "$CRASH_LOG"
  COUNT=$(wc -l < "$CRASH_LOG")
fi
if [ "$VERDICT" = "crash" ]; then
  if [ "$COUNT" -ge 5 ]; then
    mkdir -p "$HOOKS_DIR" 2>/dev/null
    touch "$DISABLED_FLAG"
    echo "" > "$CRASH_LOG"
    logger -t msb-watchdog "Agent-hooks disabled for ${BOT_ID:-legacy} after $COUNT crashes"
  fi
  if [ "$COUNT" -ge 3 ]; then
    # Blast-radius guard (R6): index.js is the SHARED engine (one per box, every bot
    # uses it). A non-primary bot crash-looping for a PER-BOT reason (missing .env,
    # bad per-bot config) must NOT roll back the whole box's engine — that punishes
    # the healthy primary and creates drift that freezes the box from updates. If the
    # primary ('default') is healthy the engine is fine, so skip the shared rollback
    # (the per-bot hooks-disable above still applies). A genuinely bad engine crashes
    # the primary too, and its own watchdog run then rolls back legitimately.
    SKIP_ROLLBACK=""
    if [ -n "$BOT_ID" ] && [ "$BOT_ID" != "default" ]; then
      if systemctl is-active --quiet msb-bot@default.service 2>/dev/null; then
        SKIP_ROLLBACK=1
        logger -t msb-watchdog "Skip shared-engine rollback for secondary ${BOT_ID} ($COUNT crashes) — primary 'default' healthy, engine OK (per-bot fault)"
      fi
    fi
    if [ -z "$SKIP_ROLLBACK" ]; then
      LATEST=$(ls -t "$VERSIONS_DIR"/index.js.* 2>/dev/null | head -1)
      if [ -n "$LATEST" ]; then
        cp "$LATEST" "$BOT_FILE"
        logger -t msb-watchdog "Auto-rollback ${BOT_ID:-legacy} to $(basename $LATEST) after $COUNT crashes"
      fi
    fi
  fi
else
  logger -t msb-watchdog "clean start for ${BOT_ID:-legacy} — not counted as crash (window: $COUNT)"
fi
# Auto-unmute: the mute is a circuit breaker, not a life sentence. If the flag
# has been up for DISABLED_TTL with a clean crash window (a crash start just
# appended above → COUNT>0 blocks this), lift it and say so in the journal.
if [ -f "$DISABLED_FLAG" ] && [ "$COUNT" -eq 0 ]; then
  FLAG_AGE=$(( NOW - $(stat -c %Y "$DISABLED_FLAG" 2>/dev/null || echo "$NOW") ))
  if [ "$FLAG_AGE" -ge "$DISABLED_TTL" ]; then
    rm -f "$DISABLED_FLAG" 2>/dev/null
    logger -t msb-watchdog "Agent-hooks re-enabled for ${BOT_ID:-legacy} — _disabled was up ${FLAG_AGE}s with a clean crash window"
  fi
fi
