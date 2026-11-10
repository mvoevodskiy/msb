#!/usr/bin/env node
'use strict';

// Guard the selected release root before the legacy platform code reads config.
if (require.main === module) {
  const runtimeProfile = require('./bot/shared/profile.cjs');
  runtimeProfile.initialize();
  if (runtimeProfile.shouldSkipVendorUpdate('puller', process.env, __dirname)) {
    console.error('[msb/puller] open-core detected — vendor puller skipped');
    process.exit(0);
  }
}

// ============================================================
// puller.cjs — Bundle pull agent (v1.2, timer-driven, graduated signal)
//
// Phase 1.5 hardening:
//  - Removed daemon mode (timer-driven via msb-tick@puller.service)
//  - Removed stagger + throttle (timer's RandomizedDelaySec handles jitter)
//  - Path traversal sanitize in resolveAssetPath()
//  - Atomic state file write (tmp + fsync + rename)
//  - min_cc_cli_version enforcement before apply
//  - Graduated restart signal (none / reload / restart) via bot-ctl.sh
//
// Reads server-side manifest, compares hashes against local state, downloads
// missing assets via presigned URLs, atomically swaps into place, ack-s the
// applied version. Triggers bot graduated action if any asset requires one.
//
// Designed for Phase 1: platform layer only (bot bundle + CC CLI). Project
// layer (bots[] section) is Phase 2 — handled identically once bot model is
// known.
//
// Config (env or /etc/msb-puller.conf JSON; msb-tick@puller.service uses
// /etc/msb-tick/puller.conf for MSB_TICK_EXEC + LIVE_DIR):
//   SYNC_KEY          — Bearer auth token, also used by heartbeat
//   BACKEND_URL       — https://constructor.../api  (no trailing slash;
//                       falls back to SYNC_URL from /home/client/.msb/.env)
//   LIVE_DIR          — /home/client/.msb  (default; resolves relative asset paths)
//   STAGING_DIR       — $LIVE_DIR/.staging
//   ROLLBACK_DIR      — $LIVE_DIR/.rollback
//   STATE_FILE        — $LIVE_DIR/.puller-state.json
//
// Bot target unit is resolved via bot-ctl.sh (multibot-aware). Puller calls
// `sudo bot-ctl.sh <action>` which handles msb-bot vs msb-bot@default.
//
// Asset paths in manifest: relative paths resolved against LIVE_DIR
// (e.g. "bot/index.js" → /home/client/.msb/bot/index.js); absolute paths
// allowed only from a small allowlist (e.g. /usr/lib/node_modules/ for CC CLI).
//
// Run:
//   node puller.cjs   — single tick, exits with code 0/1. Timer fires it.
//
// Zero dependencies — pure Node.js ≥18.
// ============================================================

// MSB: enrollment/DRM создателя снят — запись разрешена.
function legacyRuntimeWriterAllowed() { return true; }
function assertLegacyRuntimeWriter() { /* no-op */ }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

// ---------- Config ----------

const CONFIG_FILE = '/etc/msb-puller.conf';
let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch (_) { /* malformed config — fall back to env */ }

function cfg(name, fallback) {
  return process.env[name] || fileConfig[name] || fallback;
}

const SYNC_KEY     = cfg('SYNC_KEY', '');
// BACKEND_URL falls back to SYNC_URL (the per-bot .env name for the same value)
const BACKEND_URL  = (cfg('BACKEND_URL', '') || cfg('SYNC_URL', '')).replace(/\/$/, '');
const LIVE_DIR     = cfg('LIVE_DIR', '/home/client/.msb');
// Срез 2 (partner delivery): workspace is the SHARED bind-mount where the engine
// reads SOUL/USER/MEMORY/CLAUDE.md + knowledge/ + .claude/skills/ (context-loader).
// It is a SIBLING of LIVE_DIR (/home/client/workspace), NOT under it — so a
// manifest asset with base:"workspace" must resolve here, never against LIVE_DIR.
// Per-server (one workspace per box, bind-mounted into every bot) — P6.
const WORKSPACE_DIR = cfg('WORKSPACE_DIR', '/home/client/workspace');
const STAGING_DIR  = cfg('STAGING_DIR', path.join(LIVE_DIR, '.staging'));
// EXDEV fix: the overlay pass renameSync-es staged files into WORKSPACE_DIR, but
// STAGING_DIR lives under LIVE_DIR — a SIBLING of WORKSPACE_DIR that is commonly a
// SEPARATE mount (workspace is a bind-mount). A cross-device renameSync throws
// EXDEV, so the overlay atomic switch must stage on the SAME filesystem as its
// destination. Default to a hidden dir INSIDE WORKSPACE_DIR (intra-fs → rename
// stays atomic). Dot-prefixed + never a manifest asset path → invisible to the
// engine, the delivery tree, and orphan-pruning (which only ever addresses
// manifest-declared paths). Overridable via env for tests.
const OVERLAY_STAGING_DIR = cfg('OVERLAY_STAGING_DIR', path.join(WORKSPACE_DIR, '.msb-overlay-staging'));
const ROLLBACK_DIR = cfg('ROLLBACK_DIR', path.join(LIVE_DIR, '.rollback'));
const STATE_FILE   = cfg('STATE_FILE', path.join(LIVE_DIR, '.puller-state.json'));
const LOG_DIR      = cfg('PULLER_LOG_DIR', path.join(LIVE_DIR, '.puller-logs'));

const BOT_CTL = '/usr/local/bin/bot-ctl.sh';

const MAX_ROLLBACKS  = 3;
const PRESIGN_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;  // 5 min per asset
const FETCH_TIMEOUT_MS    = 30 * 1000;        // 30s for manifest/asset-url/ack
const RETRY_DELAYS_MS = [5000, 30000, 120000];

// WP-G3 circuit-breaker. The timer fires every 4h (msb-tick-puller.timer
// OnUnitActiveSec=4h), so cross-tick failure memory — not in-tick backoff —
// is what prevents an endless silent retry (silent failure is the #1 killer).
// After CIRCUIT_FAIL_THRESHOLD consecutive failed ticks the puller trips: it
// reports ONE incident (the main win = visibility) and stops attempting until
// CIRCUIT_COOLDOWN_MS elapses, then runs a single half-open trial tick.
// 3 ticks ≈ 12h — long enough to ride out a transient central/Spaces blip (a
// tripped circuit = no pull for the cooldown, so we want a persistent-failure
// signal, not a flap), short enough to surface a real outage within cadence.
// Cooldown 24h (> the 4h tick interval, so the pause is meaningful) → at most
// ~1 incident/24h while a box stays broken.
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS    = 24 * 60 * 60 * 1000;

// WP-G4 — real rollback snapshot + multi-bot health-gate + auto-revert.
// The puller changes SHARED code (one bot/index.js per server) → it must restart
// EVERY bot and gate the whole set (P2/P6: per-bot is the axis inside a server).
// "Healthy" = boots + stays active over the window (no crash-loop) + each bot
// wrote a FRESH per-bot heartbeat marker after the restart (proves it answered,
// not just "process up"). Marker is per-bot: ~/.msb/bots/<id>/.heartbeat-ok
// (legacy single-bot: ~/.msb/.heartbeat-ok).
const HEARTBEAT_MARKER_NAME    = '.heartbeat-ok';
const HEALTH_GATE_SAMPLES_MS   = [5000, 30000, 60000, 90000];
const HEALTH_GATE_ACTIVE_FROM_MS = 30000; // count is-active for the crash-loop verdict from here on
// Coordination with the crash-loop watchdog (multibot-init.sh restores
// versions/-latest on 3 crashes/300s) — it defers to the puller while this
// marker is fresh, so the two reverts don't fight (R5). TTL covers the gate
// window + restart margin and is self-expiring if the puller dies mid-apply.
const PULLER_APPLYING_MARKER   = path.join(LIVE_DIR, '.puller-applying');
const PULLER_APPLYING_TTL_MS   = 180 * 1000;

// ---------- Live-turn deferral («не рвать живой ход») ----------
// The bot keeps a per-bot `.turn-active` marker fresh (touched every 60 s, see
// src/agent/turn-marker.ts) for exactly as long as a turn is running. The watchdog and
// oc-health already honour it; the puller did NOT — an apply restarted every bot in the
// middle of an answer (the bot auto-resumes the turn, but the client still saw the cut).
// Before the FIRST disk write of an apply the puller now waits for the newest marker to go
// stale (same 180 s window as the watchdog), polling every 15 s for up to 5 min: the tick
// unit's TimeoutStartSec is 600 s and the apply + health-gate still need ~2 min after that.
// Still busy after the wait → the tick is DEFERRED without touching disk (reason
// deferred_busy); the next timer tick (≤4 h) retries. A box that is busy at EVERY tick (a
// background task every 30 min, say) would otherwise never update: after TURN_DEFER_MAX
// consecutive deferrals the puller applies anyway (auto-resume covers the interrupted turn).
const TURN_MARKER_NAME    = '.turn-active';
const TURN_BUSY_WINDOW_MS = 180 * 1000;                                   // = WATCHDOG_BUSY_WINDOW_MS
const TURN_WAIT_MAX_MS    = Number(cfg('TURN_WAIT_MAX_MS', 5 * 60 * 1000)); // in-tick wait budget
const TURN_WAIT_POLL_MS   = Number(cfg('TURN_WAIT_POLL_MS', 15 * 1000));
const TURN_DEFER_MAX      = 3;                                            // deferred ticks before forcing

// Every path the bot may keep a turn marker at: legacy single-bot + one per bots/<id>/.
function turnMarkerPaths(liveDir) {
  const root = liveDir || LIVE_DIR;
  const paths = [path.join(root, TURN_MARKER_NAME)];
  try {
    for (const id of fs.readdirSync(path.join(root, 'bots'))) paths.push(path.join(root, 'bots', id, TURN_MARKER_NAME));
  } catch (_) { /* no bots/ dir → legacy layout */ }
  return paths;
}

// Age (ms) of the NEWEST marker in the set; Infinity when none exists. statFn injectable.
function newestTurnMarkerAgeMs(paths, nowMs, statFn) {
  const stat = statFn || ((p) => fs.statSync(p));
  let newest = -Infinity;
  for (const p of paths) {
    try { const m = stat(p).mtimeMs; if (m > newest) newest = m; } catch (_) { /* absent */ }
  }
  return newest === -Infinity ? Infinity : Math.max(0, nowMs - newest);
}

// PURE decision from the observed marker age and the deferral history:
//   proceed — no live turn (marker stale or absent) → apply now
//   wait    — live turn and wait budget left → poll again
//   defer   — live turn, budget spent, deferrals below the cap → skip this tick, no disk write
//   force   — live turn, deferral cap reached → apply anyway (the bot auto-resumes the turn)
function turnDeferDecision(input) {
  const busyWindowMs = input.busyWindowMs == null ? TURN_BUSY_WINDOW_MS : input.busyWindowMs;
  const waitMaxMs    = input.waitMaxMs    == null ? TURN_WAIT_MAX_MS    : input.waitMaxMs;
  const deferMax     = input.deferMax     == null ? TURN_DEFER_MAX      : input.deferMax;
  if (!(input.ageMs < busyWindowMs)) return 'proceed';
  if (input.waitedMs < waitMaxMs) return 'wait';
  if ((Number(input.deferrals) || 0) >= deferMax) return 'force';
  return 'defer';
}

// Waits for the box's bots to go idle (all markers stale). Resolves to
// { decision: 'proceed'|'defer'|'force', waitedMs, ageMs, deferrals }. Never throws.
async function waitForIdleBots(state, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const sleepFn = o.sleep || sleep;
  const liveDir = o.liveDir || LIVE_DIR;
  const deferrals = Number(state && state.busy_deferrals) || 0;
  const waitMaxMs = o.waitMaxMs == null ? TURN_WAIT_MAX_MS : o.waitMaxMs;
  const start = now();
  let waited = 0;
  for (;;) {
    const ageMs = newestTurnMarkerAgeMs(turnMarkerPaths(liveDir), now(), o.statFn);
    const decision = turnDeferDecision({ ageMs, waitedMs: waited, deferrals, busyWindowMs: o.busyWindowMs, waitMaxMs, deferMax: o.deferMax });
    if (decision !== 'wait') return { decision, waitedMs: waited, ageMs, deferrals };
    if (waited === 0) log('INFO', `live turn in progress (marker ${Math.round(ageMs / 1000)}s old) — waiting up to ${Math.round(waitMaxMs / 1000)}s before apply`);
    await sleepFn(o.pollMs == null ? TURN_WAIT_POLL_MS : o.pollMs);
    waited = now() - start;
  }
}

// Shared by both passes: returns null to proceed, or the pass result to return early.
// opts (tests only): waitForIdleBots options + `persist` to replace saveState.
async function deferIfLiveTurn(state, what, opts) {
  const persist = (opts && opts.persist) || saveState;
  const idle = await waitForIdleBots(state, opts);
  if (idle.decision === 'defer') {
    state.busy_deferrals = idle.deferrals + 1;
    persist(state);
    log('WARN', `live turn still running after ${Math.round(idle.waitedMs / 1000)}s — deferring ${what} to the next tick (deferral ${state.busy_deferrals}/${TURN_DEFER_MAX}, nothing written)`);
    return { ok: true, reason: 'deferred_busy', deferrals: state.busy_deferrals };
  }
  if (idle.decision === 'force') {
    log('WARN', `live turn still running but ${idle.deferrals} tick(s) already deferred — applying ${what} anyway (bot auto-resumes the turn)`);
  } else if (idle.waitedMs > 0) {
    log('INFO', `bots idle after ${Math.round(idle.waitedMs / 1000)}s — applying ${what}`);
  }
  if (idle.deferrals > 0) { state.busy_deferrals = 0; persist(state); }
  return null;
}

// Absolute paths allowed in manifest assets (security allowlist).
// Anything else absolute → reject. Relative paths constrained to LIVE_DIR.
const ABSOLUTE_PATH_ALLOWLIST = ['/usr/lib/node_modules/'];

// ---------- Logging ----------

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}\n`;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, 'puller.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) {
      const oldPath = path.join(LOG_DIR, 'puller.log.old');
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      fs.renameSync(logPath, oldPath);
    }
    fs.appendFileSync(logPath, line);
  } catch (_) { /* swallow */ }
  if (process.env.PULLER_VERBOSE === '1') process.stderr.write(line);
}

// ---------- State ----------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    // WP-G3 fields (consecutive_failures, circuit_open_until) and the C4c overlay
    // field (applied_project_version) are optional and default-safe when absent
    // on older state files.
    return { applied_platform_version: null, applied_project_version: null, consecutive_failures: 0, circuit_open_until: null };
  }
}

// Atomic write: tmp + fsync + rename. Survives kill -9 mid-write.
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log('ERROR', `saveState failed: ${e.message}`);
  }
}

// ---------- HTTP ----------

function httpRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: headers || {},
      timeout: FETCH_TIMEOUT_MS,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body) {
      if (Buffer.isBuffer(body)) req.write(body);
      else req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function httpJson(method, url, body) {
  const headers = {
    'authorization': `Bearer ${SYNC_KEY}`,
    'content-type': 'application/json',
    'accept': 'application/json',
  };
  if (method === 'GET') headers['x-manifest-format'] = 'v1';
  return httpRequest(method, url, headers, body).then((res) => {
    if (res.status === 410) {
      const err = new Error('manifest format unsupported');
      err.code = 'FORMAT_UNSUPPORTED';
      err.status = 410;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    try {
      return JSON.parse(res.body.toString('utf8'));
    } catch (e) {
      throw new Error(`Invalid JSON response: ${e.message}`);
    }
  });
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const file = fs.createWriteStream(destPath);
    let received = 0;
    const req = lib.get({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      timeout: DOWNLOAD_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        file.close(() => fs.unlinkSync(destPath));
        return reject(new Error(`download HTTP ${res.statusCode}`));
      }
      res.on('data', (chunk) => { received += chunk.length; });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(received)));
    });
    req.on('error', (e) => {
      file.close(() => { try { fs.unlinkSync(destPath); } catch (_) {} });
      reject(e);
    });
    req.on('timeout', () => req.destroy(new Error('download timeout')));
  });
}

// ---------- Hashing ----------

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function sha256Dir(dirPath) {
  const entries = [];
  function walk(p, base) {
    const items = fs.readdirSync(p).sort();
    for (const item of items) {
      const abs = path.join(p, item);
      const rel = path.posix.join(base, item);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        entries.push([rel, 'symlink:' + fs.readlinkSync(abs)]);
      } else if (stat.isDirectory()) {
        walk(abs, rel);
      } else {
        entries.push([rel, sha256File(abs)]);
      }
    }
  }
  walk(dirPath, '');
  const combined = entries.map(([r, h]) => `${r}\0${h}`).join('\n');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

function localHash(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const stat = fs.lstatSync(targetPath);
  if (stat.isDirectory()) return sha256Dir(targetPath);
  if (stat.isFile()) return sha256File(targetPath);
  return null;
}

function normalizeHash(h) {
  return String(h || '').replace(/^sha256:/, '');
}

// Resolve manifest asset.path to absolute filesystem path. Throws on traversal
// or unauthorized absolute paths.
//
// C4a (Срез 2): base-aware resolution. AssetEntry.base selects the root —
//   "live" (default, back-compat) → LIVE_DIR (/home/client/.msb), platform code
//   "workspace"                   → WORKSPACE_DIR (/home/client/workspace),
//                                    partner config/content (SOUL/knowledge/skills…)
//   "absolute"                    → ABSOLUTE_PATH_ALLOWLIST only (CC CLI npm dir)
// An ABSENT base means "live" (every legacy platform manifest), so existing
// behavior is byte-for-byte unchanged. Each root has its own traversal guard.
//
// Pure (no module-level constants) so it is unit-testable with arbitrary roots;
// resolveAssetPath() below binds the live module config.
function resolveAssetPathPure(asset, opts) {
  const { liveDir, workspaceDir, absoluteAllowlist } = opts;
  if (typeof asset.path !== 'string' || !asset.path) {
    throw new Error('asset.path missing or not a string');
  }
  const base = asset.base || 'live';

  // Explicit workspace base: partner config/content. MUST be relative — an
  // absolute path here is rejected outright (the absolute allowlist is a
  // platform/code concern; partner content can never reach it). Security gate:
  // partner authors config/content only, never engine code.
  if (base === 'workspace') {
    if (path.isAbsolute(asset.path)) {
      throw new Error(`workspace asset path must be relative: ${asset.path}`);
    }
    const root = path.resolve(workspaceDir);
    const resolved = path.resolve(root, asset.path);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`asset path escapes workspace root: ${asset.path}`);
    }
    return resolved;
  }

  // base "absolute", or base "live"/absent WITH a literal absolute path: the
  // existing allowlist semantics (CC CLI under /usr/lib/node_modules/) — kept
  // byte-identical so platform code/CC-CLI manifests are unaffected.
  if (base === 'absolute' || path.isAbsolute(asset.path)) {
    const allowed = absoluteAllowlist.some((prefix) => asset.path.startsWith(prefix));
    if (!allowed) {
      throw new Error(`asset absolute path not in allowlist: ${asset.path}`);
    }
    // Normalize to defeat /usr/lib/node_modules/../../../etc/shadow
    const normalized = path.resolve(asset.path);
    if (!absoluteAllowlist.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`asset absolute path normalizes outside allowlist: ${asset.path}`);
    }
    return normalized;
  }

  if (base !== 'live') {
    throw new Error(`asset has unknown base: ${base}`);
  }
  // base "live" (default), relative: resolve against LIVE_DIR, stay inside.
  const liveResolved = path.resolve(liveDir);
  const resolved = path.resolve(liveDir, asset.path);
  if (resolved !== liveResolved && !resolved.startsWith(liveResolved + path.sep)) {
    throw new Error(`asset path escapes LIVE_DIR: ${asset.path}`);
  }
  return resolved;
}

function resolveAssetPath(asset) {
  return resolveAssetPathPure(asset, {
    liveDir: LIVE_DIR,
    workspaceDir: WORKSPACE_DIR,
    absoluteAllowlist: ABSOLUTE_PATH_ALLOWLIST,
  });
}

// ---------- CC CLI version check ----------

let _cachedCcVersion = null;
function getCcCliVersion() {
  if (_cachedCcVersion !== null) return _cachedCcVersion;
  try {
    const out = execSync('claude --version 2>&1', { timeout: 10000, encoding: 'utf8' });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    _cachedCcVersion = m ? `${m[1]}.${m[2]}.${m[3]}` : '';
  } catch (_) {
    _cachedCcVersion = '';
  }
  return _cachedCcVersion;
}

function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function assetMeetsCcRequirement(asset) {
  if (!asset.min_cc_cli_version) return true;
  const installed = getCcCliVersion();
  if (!installed) return false;
  return compareSemver(installed, asset.min_cc_cli_version) >= 0;
}

// ---------- CC engine smoke (health-gate deepening — behind flag, fail-safe) ----------
//
// The process health-gate (runHealthGate) proves the BOT PROCESS booted and wrote a
// fresh heartbeat marker after the restart. It does NOT prove the CC ENGINE BINARY
// still executes: a bad CC-CLI bump (the exact shape of the problematic v26) can
// install cleanly and leave the process "up" while the engine is broken → the box
// passes the gate, acks the version, and silently serves broken dialogs.
//
// This smoke closes part of that blind spot by proving the CC-CLI binary still
// EXECUTES after an apply — a cheap, NETWORK-FREE, BYOK-FREE check.
//
// SCOPE = DETECTION, NOT SELF-HEAL. On a definitive engine failure this smoke DOES
// NOT revert. Reason: the CC-CLI ships as an npm asset, and snapshotForRollback /
// revertFromSnapshot deliberately SKIP install_method==='npm'. So a "revert" here
// would roll the FILE assets back to N-1 while the broken CLI stays at N → the box
// lands on "old code + broken engine", and (low probability) restoring N-1 files
// under a live N process could even topple a still-serving process — strictly worse
// than the flag being OFF. Instead, on `fail` the smoke: BLOCKS THE ACK (does not
// advance applied_platform_version), raises a distinct `cc_smoke_failed` incident
// (reverted=false), and leaves the ALIVE process exactly as-is. The value is
// visibility — never silently acking a broken engine — retried next tick and
// bounded by the circuit-breaker. Full self-heal (npm-rollback of the CLI) is a
// separate future feature, not this one.
//
// WHY `--version` (executability) and NOT a model round-trip: a real prompt
// round-trip would exercise the dialog path end-to-end, but on a CLIENT box it
// depends on the client's BYOK key + gateway + network. A dead/expired OpenRouter
// key — a common, NOT-our-fault condition that already surfaces as a timeout
// (oc-byok-401-surfaces-as-timeout) — would make such a smoke "fail" and falsely
// block a HEALTHY box: a fail-safe violation. So the smoke is strictly an
// executability probe with no external dependency. It catches the broad "new CC-CLI
// can't even run" class (corrupt bundle, bad dependency, Node ABI mismatch); it does
// NOT catch "version prints but dialog subtly broken" — that cannot be probed
// cheaply/safely on a client box, by design (documented limitation).
//
// CANARY GATE (#2): the fail-path rests on the assumption "a healthy `claude
// --version` exits 0". That assumption is validated EMPIRICALLY on the canary box
// (Tom's box) BEFORE the flag is enabled fleet-wide — fail-on-nonzero stays as-is.
//
// FLAG: default OFF. Enabled per-box via HEALTHGATE_CC_SMOKE=1 (env or
// /etc/msb-puller.conf) for canary rollout. While OFF the puller is byte-for-byte
// unchanged (the smoke block is skipped entirely).
const CC_SMOKE_TIMEOUT_MS = 15000;
// Explicit output cap for `claude --version` (kilobytes of version text at most).
// WHY explicit: with the default maxBuffer a broken engine that spams >1 MB on
// --version overflows → execSync kills the child (killed + SIGTERM) → we would
// misclassify it as our own timeout → skip, masking the detection. An explicit cap
// + an ENOBUFS branch (ccSmokeRaw) turns overflow into a FAIL, not a silent skip.
const CC_SMOKE_MAXBUFFER = 2 * 1024 * 1024;

function ccSmokeEnabled() {
  return cfg('HEALTHGATE_CC_SMOKE', '') === '1';
}

// Fault signals — SAFETY NET only. In production the smoke runs `claude --version
// 2>&1` through `/bin/sh -c`, so a child crash is converted by the SHELL into an
// EXIT CODE 128+n (a segfault → exit 139, SIGABRT → 134) that lands on `.status` and
// is caught by the exit-code branch below. execSync therefore rarely surfaces a raw
// `.signal` here; this set only matters for a hypothetical no-shell/direct-spawn
// caller. (SIGTERM/SIGKILL are excluded — those are OUR timeout kill / an OOM-killer,
// ambiguous, never "engine broken".)
const CC_SMOKE_CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGBUS', 'SIGFPE', 'SIGTRAP']);

// PURE: classify a raw smoke result into pass | fail | skip. Maximally fail-safe:
// a 'fail' (→ BLOCK the ack, NOT revert — see the section header) requires a POSITIVE
// signal that the binary EXECUTED AND FAILED — a concrete non-zero exit code, an
// output overflow, or a crash/fault signal. Everything else that cannot be attributed
// to the engine itself (binary absent, our own timeout, an un-attributable throw) is
// UNCERTAIN → skip, which must NEVER block a healthy apply.
//   raw = { ran, exitCode, signal, timedOut, notFound, bufferOverflow }
function ccSmokeVerdict(raw) {
  if (!raw) return { status: 'skip', reason: 'cc_smoke_no_result' };
  if (raw.ran) return { status: 'pass', reason: 'cc_cli_executed' };
  if (raw.notFound) return { status: 'skip', reason: 'cc_cli_not_found' };
  if (raw.timedOut) return { status: 'skip', reason: 'cc_smoke_timeout' };
  // POSITIVE "executed and failed": `claude --version` makes no network call and
  // needs no BYOK key, so a real non-zero exit / overflow / crash there means the
  // engine binary itself is broken → block.
  if (typeof raw.exitCode === 'number' && raw.exitCode !== 0 && raw.exitCode !== 127) {
    return { status: 'fail', reason: 'cc_cli_exit_' + raw.exitCode };
  }
  // Output overflow: a healthy `--version` prints a few bytes; blowing past the cap
  // means the binary is malfunctioning (and must NOT be masked as a timeout skip).
  if (raw.bufferOverflow) {
    return { status: 'fail', reason: 'cc_cli_output_overflow' };
  }
  if (raw.signal && CC_SMOKE_CRASH_SIGNALS.has(raw.signal)) {
    return { status: 'fail', reason: 'cc_cli_crash_' + raw.signal };
  }
  // Threw, but we can't positively attribute it to the engine → uncertain, skip.
  return { status: 'skip', reason: 'cc_smoke_indeterminate' };
}

// Translate ONE exec attempt (returns stdout, or throws an execSync-style error)
// into the pure `raw` shape ccSmokeVerdict consumes. `execFn` is injected so the
// classification is unit-testable without spawning claude.
function ccSmokeRaw(execFn) {
  try {
    const stdout = execFn();
    return { ran: true, exitCode: 0, signal: null, timedOut: false, notFound: false, stdout: String(stdout == null ? '' : stdout) };
  } catch (e) {
    const status = e && typeof e.status === 'number' ? e.status : null;
    const signal = (e && e.signal) || null;
    const code = e && e.code;
    const killed = !!(e && e.killed);
    // maxBuffer exceeded: spawnSync sets code 'ENOBUFS' AND kills the child (killed +
    // SIGTERM). Detect it FIRST so the overflow is classified as a FAIL (broken engine
    // spamming output), NOT masked as our timeout skip below.
    const bufferOverflow = code === 'ENOBUFS';
    // execSync kills on timeout with killSignal (default SIGTERM); ETIMEDOUT may also
    // surface. Either way it is OUR kill, not an engine crash → uncertain. Overflow is
    // excluded (it is a real engine fault, handled above/in the verdict).
    const timedOut = !bufferOverflow && (code === 'ETIMEDOUT' || (killed && (signal === 'SIGTERM' || signal === 'SIGKILL')));
    // Shell "command not found" exits 127; a no-shell spawn gives ENOENT.
    const notFound = status === 127 || code === 'ENOENT';
    return {
      ran: false, exitCode: status, signal, timedOut, notFound, bufferOverflow,
      stdout: String((e && (e.stdout || e.stderr)) || ''),
    };
  }
}

// Run the CC engine smoke once (box-level; the CC-CLI is SHARED across all bots).
// Uses a FRESH `claude --version` — never the cached getCcCliVersion, which may
// still hold the PRE-apply version. ANY unexpected failure of the smoke harness
// itself → skip (never a false fail); fail-safe is paramount. `exec` injectable.
function runCcEngineSmoke(opts) {
  opts = opts || {};
  const exec = opts.exec || (() => execSync('claude --version 2>&1', {
    timeout: CC_SMOKE_TIMEOUT_MS, maxBuffer: CC_SMOKE_MAXBUFFER, encoding: 'utf8',
  }));
  let raw;
  try {
    raw = ccSmokeRaw(exec);
  } catch (_) {
    return { status: 'skip', reason: 'cc_smoke_harness_error', exitCode: null, signal: null, stdout: '' };
  }
  const v = ccSmokeVerdict(raw);
  return { status: v.status, reason: v.reason, exitCode: raw.exitCode, signal: raw.signal, stdout: (raw.stdout || '').slice(0, 200) };
}

// PURE: map a smoke result to the gate action. ONLY a definitive 'fail' BLOCKS (the
// caller then withholds the ack + raises an incident, WITHOUT reverting file assets —
// see the section header for why revert is wrong for an npm-delivered CLI). 'pass'
// and 'skip' both proceed (an uncertain smoke must never block a healthy apply).
// Defensive default: a missing/garbage result → proceed.
function ccSmokeGateOutcome(smoke) {
  return smoke && smoke.status === 'fail' ? 'block' : 'proceed';
}

// ---------- Restart action (graduated signal) ----------

// Resolve restart action per asset: explicit field wins, else deduce from
// legacy requires_restart boolean. Values: "none" | "reload" | "restart".
function assetRestartAction(asset) {
  const explicit = asset.restart_action;
  if (explicit === 'none' || explicit === 'reload' || explicit === 'restart') {
    return explicit;
  }
  return asset.requires_restart ? 'restart' : 'none';
}

// Aggregate across applied assets. Heavy wins: restart > reload > none.
function aggregateRestartAction(assets) {
  let strongest = 'none';
  for (const a of assets) {
    const act = assetRestartAction(a);
    if (act === 'restart') return 'restart';
    if (act === 'reload') strongest = 'reload';
  }
  return strongest;
}

// ---------- Incident reporting ----------

async function reportIncident(version, assetPath, phase, errMsg, attempt, reverted, extra) {
  try {
    const payload = {
      manifest_version: version,
      asset_path: assetPath,
      phase,
      error: String(errMsg).slice(0, 2000),
      attempt_count: attempt,
      // Explicit auto-revert signal — the ramp cockpit (rollout-status) counts
      // reverted boxes from this rather than string-matching the error message.
      reverted: reverted === true,
    };
    // FALSE-revert classification (optional). When a revert was caused by a host
    // privilege gap (no NOPASSWD sudoers on bot-ctl.sh → sudo probe fails → live
    // bot misread as inactive → false rollback), tag it so the server EXCLUDES it
    // from the auto-halt threshold. Only emitted for the health-gate revert path;
    // omitted elsewhere → server defaults to false → counts as before.
    if (extra && typeof extra.privilege_error === 'boolean') {
      payload.privilege_error = extra.privilege_error;
    }
    // WP-G7 pre-state gate: remnant bots (dead BEFORE the pull) the health-gate
    // skipped. Names are systemd bot-ids (no secrets); capped so a corrupt
    // bots/ tree can't bloat the event row.
    if (extra && Array.isArray(extra.skipped_preexisting_dead) && extra.skipped_preexisting_dead.length) {
      payload.skipped_preexisting_dead = extra.skipped_preexisting_dead.slice(0, 20).map((n) => String(n).slice(0, 64));
    }
    if (extra && extra.all_bots_preexisting_dead === true) {
      payload.all_bots_preexisting_dead = true;
    }
    await httpJson('POST', `${BACKEND_URL}/api/fleet/install-incident`, payload);
  } catch (e) {
    log('WARN', `reportIncident failed: ${e.message}`);
  }
}

// ---------- Privilege-error classification (false-revert guard) ----------
//
// Root cause of the 8-day auto-halt freeze: on legacy boxes the puller's account
// has NO passwordless sudo for /usr/local/bin/bot-ctl.sh, so `sudo bot-ctl.sh
// restart|is-active` fails with "sudo: a password is required" (or tty/askpass/
// permission). The health-gate then reads a LIVE bot as "inactive" → FALSE revert
// (reverted:true) → 3 such false reverts tripped the fleet auto-halt off boxes
// that were actually alive on a HEALTHY build. Fix = CLASSIFY these reverts as
// privilege errors so the server does not count them toward the halt threshold.
// The revert MECHANIC is unchanged — the box still rolls back to the known-good
// version and stays consistent; only the incident LABEL changes.
//
// A genuine BAD BUILD surfaces "permission denied" from the systemd EXEC step
// (non-executable entrypoint / broken unit / rejected sandbox / bad binary), NOT from
// sudo or the bot-ctl.sh invocation. That MUST stay a REAL revert so a broken build
// still trips auto-halt (review MAJOR: a bare "permission denied" match would tag such
// a build privilege_error → exclude it from the halt count → roll it fleet-wide
// unchecked). BAD_BUILD_EXEC_RE is checked FIRST and wins — fail-safe direction (worst
// case a true privilege error is counted as a real revert = pre-fix behavior).
const BAD_BUILD_EXEC_RE = /failed at step \w+|\/EXEC\b|exec format error|spawning\s+\S+:\s*permission denied/i;
const PRIVILEGE_ERROR_RE = /\bsudo\b.*(password|tty)|a password is required|no ?askpass|permission denied/i;

// PURE: does this error text carry a sudo/privilege signature? Fail-safe: only an
// EXPLICIT signature returns true; anything else (e.g. systemctl "inactive", a real
// crash, a timeout) returns false → treated as a real revert, preserving behavior.
function isPrivilegeError(errText) {
  const t = String(errText == null ? '' : errText);
  if (BAD_BUILD_EXEC_RE.test(t)) return false; // real bad-build exec failure — NOT privilege
  return PRIVILEGE_ERROR_RE.test(t);
}

// Flatten an execSync error into searchable text (message + stderr + stdout). The
// sudo signature lands on stderr; stdout may carry "inactive" for a genuine down.
function errText(e) {
  if (!e) return '';
  return [e.message, e.stderr, e.stdout]
    .map((x) => (x == null ? '' : String(x)))
    .join(' ');
}

// PURE: classify a revert from the bot-ctl.sh error texts collected during the
// restart + health-probe. privilege_error iff ANY collected text matches the sudo
// signature. If none do (real crash/crash-loop, or no error captured), returns
// false → the revert counts toward auto-halt exactly as before (fail-safe).
function classifyRevertPrivilege(errTexts) {
  if (!Array.isArray(errTexts)) return false;
  return errTexts.some((t) => isPrivilegeError(t));
}

// ---------- npm installer ----------

function installNpmPackage(pkg, version) {
  assertLegacyRuntimeWriter();
  const versionSafe = /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  if (!versionSafe) throw new Error(`unsafe npm version: ${version}`);
  // Restrict pkg to npm package name charset to prevent shell injection.
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-_.]{0,213}$/.test(pkg)) {
    throw new Error(`unsafe npm package name: ${pkg}`);
  }
  log('INFO', `npm install -g ${pkg}@${versionSafe}`);
  execSync(`sudo npm install -g ${pkg}@${versionSafe} --no-audit --no-fund > /tmp/puller-npm-$(date +%s).log 2>&1 && sleep 30`, {
    timeout: 300000, stdio: 'pipe',
  });
}

// ---------- Atomic install ----------

function ensureDir(p) {
  assertLegacyRuntimeWriter();
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyForStaging(srcAsset, stagingRoot, asset) {
  assertLegacyRuntimeWriter();
  const destPath = path.join(stagingRoot, asset.path);
  ensureDir(path.dirname(destPath));
  fs.renameSync(srcAsset, destPath);
  if (asset.permissions) {
    try { fs.chmodSync(destPath, parseInt(asset.permissions, 8)); } catch (_) {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// WP-G6 preserve-enforce belt — now layer-aware (C4b, Срез 2).
//
// "Preserved" = the puller must NEVER write/snapshot/revert this path (it would
// clobber a client-owned file or duplicate secrets into ROLLBACK_DIR/versions/).
//
//   • PLATFORM layer (or legacy/absent layer): unchanged G6a belt — any
//     category:"config" asset is preserved. Client-owned config (.env, per-bot
//     state) is policy:preserve in the A0 registry and never in the manage
//     manifest (invariant manage⇒replace); this is defense-in-depth against a
//     leaked config entry. Byte-for-byte the prior behavior.
//   • PARTNER layers (project | client): the partner DELIVERS config/content.
//     The composer stamps each asset's policy (resolveAssetPolicy) — "replace"
//     and "seed-once" are deliverable (NOT preserved); only an explicit
//     "preserve" (not emitted today, future-proof) is held. seed-once's
//     skip-if-exists is an APPLY-time decision (see assetApplyDecision), NOT a
//     preserve. The composer also confines partner paths to base:"workspace"
//     (C4a) and to typed config/content surfaces (partner-policy gate), so a
//     partner asset can never address engine code regardless of this belt.
//
// PURE. Reads only the STAMPED fields — never calls resolveAssetPolicy.
function isPreservedConfig(asset) {
  if (!asset) return false;
  const layer = asset.layer || 'platform';
  if (layer === 'project' || layer === 'client') {
    return asset.policy === 'preserve';
  }
  // platform / legacy
  return asset.category === 'config';
}

// C4b: pure apply decision for ONE asset given whether the target file already
// exists on the box. The content-apply pass (C4c) consults this per partner
// asset. Reads the STAMPED policy/layer only (composer already resolved them).
//   'skip-preserve'    → never touch (isPreservedConfig)
//   'skip-seed-exists' → seed-once AND the file is already present → keep the
//                        box's version (agent/user-accumulated docs); a fresh
//                        box (no file) gets it planted ('write')
//   'write'            → replace it / create it (policy "replace", or platform
//                        code with no stamped policy)
function assetApplyDecision(asset, fileExists) {
  if (isPreservedConfig(asset)) return 'skip-preserve';
  if (asset && asset.policy === 'seed-once') {
    return fileExists ? 'skip-seed-exists' : 'write';
  }
  return 'write';
}

// ---------- Overlay (Срез 2 / C4c) — partner config/content apply ----------
//
// The overlay layer carries the partner's workspace config/content (SOUL/persona,
// knowledge, skills, client docs) — NEVER engine code. It is applied by an
// INDEPENDENT pass (planOverlayApply → applyOverlay) that mirrors the platform
// machinery (diff → fetch → snapshot → atomic-switch → restart-by-category → ack)
// but targets WORKSPACE_DIR, and runs even when the platform layer is null/held.
//
// Restart semantics (conservative, §8.1 of the C4c design):
//   • category:"identity" (SOUL.md / persona) → the running bot must re-read the
//     persona → "reload" (gated by the same health-gate as platform restarts).
//   • everything else (knowledge / skill / config) → "none": the engine reads
//     workspace per session (context-loader), so new content is picked up on the
//     next conversation without disrupting in-flight sessions. This is the safe
//     choice for the SHARED multibot workspace — an unnecessary restart there
//     would bounce every bot on the box.
//   • an explicit asset.restart_action (if the server ever stamps one) wins.
// Heavy wins on aggregation: restart > reload > none.
function overlayAssetRestartAction(asset) {
  const explicit = asset && asset.restart_action;
  if (explicit === 'none' || explicit === 'reload' || explicit === 'restart') {
    return explicit;
  }
  return (asset && asset.category === 'identity') ? 'reload' : 'none';
}

function aggregateOverlayRestartAction(assets) {
  let strongest = 'none';
  for (const a of assets) {
    const act = overlayAssetRestartAction(a);
    if (act === 'restart') return 'restart';
    if (act === 'reload') strongest = 'reload';
  }
  return strongest;
}

// ---------- M6: overlay tombstone (orphan-prune) semantics ----------
//
// PURE. Compute the set of workspace paths the overlay AUTHORITATIVELY OWNS in
// THIS manifest, from the planOverlayApply output. "Owned" = the overlay fully
// controls the file's content (policy "replace"): it is delivered/overwritten by
// the template and carries no client-accumulated state. These — and ONLY these —
// are safe to delete when they drop out of a later template version.
//
// Deliberately EXCLUDED (never owned → never pruned):
//   • seed-once  — the box keeps its own copy (client/agent-accumulated docs like
//                  USER.md/MEMORY.md); the template only plants it on a fresh box.
//   • preserve   — client-owned, the puller must never touch it.
//   • reject-path — defense-in-depth drops; a rejected asset does NOT mean the
//                   file is owned (and a rejected manifest is treated as not
//                   faithfully representable → caller skips the prune entirely).
//
// Only the file's relative path is recorded (the durable identity across
// versions); base is always "workspace" for overlay assets.
function overlayOwnedPathsFromPlan(plan) {
  const owned = [];
  for (const p of (plan || [])) {
    if (!p || !p.asset) continue;
    if (p.status === 'reject-path') continue;
    if (isPreservedConfig(p.asset)) continue;     // preserve → never owned
    if (p.asset.policy === 'seed-once') continue;  // client-accumulated → never owned
    // policy "replace" (or platform-style no-policy, but overlay always stamps it):
    // overlay fully controls this file → owned.
    owned.push(p.asset.path);
  }
  // Dedupe (a manifest shouldn't repeat a path, but be defensive).
  return Array.from(new Set(owned));
}

// PURE. Given the previously-owned overlay paths (from .puller-state.json) and
// the currently-owned set, return the paths that DROPPED OUT of the template →
// orphans to delete from the workspace. A path still present (in either set's
// intersection) is kept; only "was owned, no longer in the set" is pruned.
function overlayOrphanPaths(prevOwned, currentOwned) {
  const cur = new Set(currentOwned || []);
  const out = [];
  for (const p of (prevOwned || [])) {
    if (typeof p !== 'string' || !p) continue;
    if (!cur.has(p)) out.push(p);
  }
  return Array.from(new Set(out));
}

// M6: delete the orphaned overlay-owned files (dropped out of the template) from
// WORKSPACE_DIR. Each path is re-validated through the SAME workspace traversal
// guard (resolveAssetPath with a synthetic base:"workspace" asset) so a poisoned
// state path can never address outside the workspace. Best-effort per file: a
// missing file (already gone) or a failed unlink does not abort the others.
// Returns the list actually removed (for logging/telemetry).
function pruneOverlayOrphanFiles(orphanPaths) {
  assertLegacyRuntimeWriter();
  const removed = [];
  for (const rel of (orphanPaths || [])) {
    let abs;
    try { abs = resolveAssetPath({ base: 'workspace', path: rel }); }
    catch (e) { log('WARN', `overlay prune: skip unresolvable orphan ${rel}: ${e.message}`); continue; }
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removed.push(rel);
        log('INFO', `overlay prune: removed orphaned template file ${rel}`);
      }
    } catch (e) {
      log('WARN', `overlay prune: unlink ${rel} failed: ${e.message}`);
    }
  }
  return removed;
}

// PURE: plan the overlay apply for one tick. For each asset compute:
//   { asset, status, resolvedPath?, reason? }
// status ∈
//   'fetch'             → hash differs from local AND decision=write → fetch+apply
//   'seed-missing'      → seed-once + file ABSENT → fetch+apply (plant on fresh box)
//   'skip-hash-match'   → on-disk hash already equals asset.hash → no-op
//   'skip-seed-exists'  → seed-once + file present → keep the box's copy
//   'skip-preserve'     → policy:preserve / preserved config → never touch
//   'reject-path'       → resolved path is invalid / escapes workspace (defense
//                         in depth) / base is not "workspace" (engine code can
//                         never arrive via the overlay) → asset dropped, soft
//                         incident; does NOT fail the whole tick.
//
// Injected: resolvePath(asset)->string|throws, hashOf(path)->string|null. Pure so
// it is unit-testable with synthetic roots and no filesystem.
function planOverlayApply(assets, deps) {
  const { resolvePath, hashOf } = deps;
  const plan = [];
  for (const asset of (assets || [])) {
    // Defense-in-depth: a partner overlay asset MUST be base:"workspace". The
    // server-side composer already confines partner content to workspace (C4a),
    // but the puller re-checks: anything else (live/absolute/absent) could
    // address engine code and is rejected outright here.
    if (asset.base !== 'workspace') {
      plan.push({ asset, status: 'reject-path', reason: `overlay asset base must be "workspace", got ${asset.base == null ? 'absent' : asset.base}` });
      continue;
    }
    let resolvedPath;
    try {
      resolvedPath = resolvePath(asset);
    } catch (e) {
      plan.push({ asset, status: 'reject-path', reason: e.message });
      continue;
    }
    let exists, local;
    try {
      local = hashOf(resolvedPath);
      exists = local !== null;
    } catch (e) {
      plan.push({ asset, status: 'reject-path', resolvedPath, reason: `localHash failed: ${e.message}` });
      continue;
    }
    const decision = assetApplyDecision(asset, exists);
    if (decision === 'skip-preserve') {
      plan.push({ asset, status: 'skip-preserve', resolvedPath });
      continue;
    }
    if (decision === 'skip-seed-exists') {
      plan.push({ asset, status: 'skip-seed-exists', resolvedPath });
      continue;
    }
    // decision === 'write' (replace, or seed-once on a fresh box)
    if (exists && local === normalizeHash(asset.hash)) {
      plan.push({ asset, status: 'skip-hash-match', resolvedPath });
      continue;
    }
    plan.push({
      asset,
      status: asset.policy === 'seed-once' && !exists ? 'seed-missing' : 'fetch',
      resolvedPath,
    });
  }
  return plan;
}

// Marker name (inside a snapshot dir) listing the relative asset paths that did
// NOT exist on disk at snapshot time. H7: these are files the apply CREATES for
// the first time — there is no prior content to restore, so a revert must DELETE
// them, not leave the (possibly broken, e.g. a bad first SOUL.md) new file on
// disk where it would crash-loop a fresh box.
const SNAPSHOT_TOMBSTONE_NAME = '.tombstones.json';

// WP-G4: real content snapshot of the files this apply will replace →
// ROLLBACK_DIR/<prevVersion>/<path>. Also mirrors the bot entrypoint into
// bot/versions/ so the crash-loop watchdog (multibot-init.sh restores
// versions/-latest) converges on the SAME prior content the puller would revert
// to (R5 content-convergence). Returns the snapshot dir.
//
// H7: for each apply-target file that does NOT yet exist, record a tombstone
// (its relative path) instead of skipping silently. revertFromSnapshot deletes
// tombstoned files so a first-time-created bad file (e.g. a partner's first
// SOUL.md that bricks the persona) does not survive the rollback.
function snapshotForRollback(prevVersion, assets) {
  assertLegacyRuntimeWriter();
  ensureDir(ROLLBACK_DIR);
  const label = prevVersion || 'pre-initial';
  const dir = path.join(ROLLBACK_DIR, label);
  ensureDir(dir);
  const tombstones = [];
  for (const a of assets) {
    if (a.install_method === 'npm') continue;
    if (isPreservedConfig(a)) continue; // WP-G6: never snapshot client-owned config/secrets
    let live;
    try { live = resolveAssetPath(a); } catch (_) { continue; }
    if (!fs.existsSync(live)) {
      // File created for the first time by this apply → tombstone so a revert
      // removes it (no prior content exists to restore).
      tombstones.push(a.path);
      continue;
    }
    const dest = path.join(dir, a.path);
    try {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(live, dest);
      if (a.path === 'bot/index.js') {
        const versionsDir = path.join(LIVE_DIR, 'bot', 'versions');
        ensureDir(versionsDir);
        fs.copyFileSync(live, path.join(versionsDir, `index.js.${Date.now()}`));
      }
    } catch (e) {
      log('WARN', `snapshot ${a.path} failed: ${e.message}`);
    }
  }
  // Persist the tombstone list inside the snapshot dir (consumed by revert).
  try {
    fs.writeFileSync(path.join(dir, SNAPSHOT_TOMBSTONE_NAME), JSON.stringify(tombstones));
  } catch (e) {
    log('WARN', `tombstone write failed: ${e.message}`);
  }
  // Keep the .json marker so cleanupOldRollbacks can prune by recency.
  fs.writeFileSync(path.join(ROLLBACK_DIR, `${label}.json`),
    JSON.stringify({ version: prevVersion, snapshotted_at: new Date().toISOString(), dir }));
  return dir;
}

// Restore the snapshotted files back into place (used on health-gate failure /
// atomic-switch failure). Copy (not move) so the snapshot survives for retries.
//
// H7: files recorded as tombstones (did not exist before the apply) are DELETED
// rather than restored — there is no prior content, and leaving the newly
// written (possibly broken) file on disk would defeat the revert.
function revertFromSnapshot(snapshotDir, assets) {
  assertLegacyRuntimeWriter();
  // Load the tombstone set for this snapshot (paths the apply created fresh).
  let tombstones = new Set();
  try {
    const raw = fs.readFileSync(path.join(snapshotDir, SNAPSHOT_TOMBSTONE_NAME), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) tombstones = new Set(arr);
  } catch (_) { /* no tombstone file (older snapshot) → behave as before */ }

  for (const a of assets) {
    if (a.install_method === 'npm') continue;
    if (isPreservedConfig(a)) continue; // WP-G6: never restore over client-owned config
    let live;
    try { live = resolveAssetPath(a); } catch (_) { continue; }
    // H7: file did not exist before this apply → delete the freshly created one.
    if (tombstones.has(a.path)) {
      try {
        if (fs.existsSync(live)) fs.unlinkSync(live);
      } catch (e) {
        log('ERROR', `revert (delete new) ${a.path} failed: ${e.message}`);
      }
      continue;
    }
    const snap = path.join(snapshotDir, a.path);
    if (!fs.existsSync(snap)) continue;
    try {
      ensureDir(path.dirname(live));
      fs.copyFileSync(snap, live);
      if (a.permissions) { try { fs.chmodSync(live, parseInt(a.permissions, 8)); } catch (_) {} }
    } catch (e) {
      log('ERROR', `revert ${a.path} failed: ${e.message}`);
    }
  }
}

// Enumerate the bots on this server. Multi-bot: ~/.msb/bots/<id>/ dirs (shared
// code, per-bot config/state). Legacy single-bot: one entry (id=null) targeting
// the default bot-ctl unit and the flat ~/.msb/.heartbeat-ok marker.
function enumerateBots(liveDir) {
  const root = path.join(liveDir || LIVE_DIR, 'bots');
  let ids = [];
  try {
    if (fs.existsSync(root)) {
      ids = fs.readdirSync(root).filter((d) => {
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(d)) return false;
        try { return fs.statSync(path.join(root, d)).isDirectory(); } catch (_) { return false; }
      });
    }
  } catch (_) { /* fall through to legacy */ }
  if (ids.length === 0) {
    return [{ id: null, markerPath: path.join(liveDir || LIVE_DIR, HEARTBEAT_MARKER_NAME) }];
  }
  return ids.map((id) => ({ id, markerPath: path.join(root, id, HEARTBEAT_MARKER_NAME) }));
}

function botCtl(action, botId) {
  assertLegacyRuntimeWriter();
  execSync(`sudo ${BOT_CTL} ${botId ? `${action} ${botId}` : action}`, { timeout: 30000, stdio: 'pipe' });
}

// Revert-path restart (E2 canary fix). The crash that tripped the health-gate may
// have burned the unit's StartLimitBurst — systemd now holds it in `failed` and a
// plain restart is a no-op, so the box stays DOWN until a human runs reset-failed
// (an outage of every reverted box during a ramp). The watchdog can't save it: it
// correctly defers (.puller-applying) and no longer kills crashes itself. So clear
// the failed/start-limit counter FIRST, then restart, per bot. reset-failed is a
// no-op when the unit isn't failed; each step is best-effort (one bad bot must not
// block the rest). bot-ctl.sh already whitelists `reset-failed`. Runner-injected
// so the order (reset-failed → restart) is unit-testable without systemd.
function revertRestartBots(bots, run) {
  for (const b of bots) {
    try { run('reset-failed', b.id); } catch (_) {}
    try { run('restart', b.id); } catch (_) {}
  }
}

// errSink (optional): when the probe throws WITHOUT proving 'active', the flattened
// error text is pushed here so runHealthGate can tell a sudo/privilege failure (a
// LIVE bot misread as down) apart from a genuine inactive. Return value/behavior is
// unchanged — still 'active' iff stdout says so.
function isBotActive(botId, errSink) {
  const cmd = `sudo ${BOT_CTL} is-active${botId ? ' ' + botId : ''}`;
  try {
    return execSync(cmd, { timeout: 10000, encoding: 'utf8' }).trim() === 'active';
  } catch (e) {
    // bot-ctl/systemctl exit non-zero for inactive — stdout still carries state.
    const active = String((e && e.stdout) || '').trim() === 'active';
    if (!active && Array.isArray(errSink)) errSink.push(errText(e));
    return active;
  }
}

// PURE: per-bot health verdict. Healthy iff the unit stayed active across the
// late samples (no crash-loop) AND — when the bot is marker-capable (a marker
// file exists) — it wrote a FRESH marker after the restart (proves it actually
// came back to life and answered, not merely "process up"). Pre-G4b bots that
// never write a marker fall back to is-active only (transitional, so the first
// marker-introducing apply can't brick).
function botHealthVerdict({ activeLate, markerExists, markerMtimeMs, restartTs }) {
  if (!activeLate) return { healthy: false, reason: 'inactive_or_crashloop' };
  if (markerExists && !(markerMtimeMs > restartTs)) {
    return { healthy: false, reason: 'stale_heartbeat_marker' };
  }
  return { healthy: true, reason: markerExists ? 'active_and_answered' : 'active_no_marker' };
}

// Run the health-gate across all bots after a restart. Samples is-active over the
// window (a crash-looping unit shows inactive at some late sample), then checks
// each bot's fresh-marker proof. Returns {healthy, detail}.
async function runHealthGate(bots, restartTs, errSink) {
  let elapsed = 0;
  const inactiveSeen = new Set();
  for (const at of HEALTH_GATE_SAMPLES_MS) {
    await sleep(at - elapsed); elapsed = at;
    if (at < HEALTH_GATE_ACTIVE_FROM_MS) continue;
    for (const b of bots) {
      if (!isBotActive(b.id, errSink)) inactiveSeen.add(b.id || 'legacy');
    }
  }
  const unhealthy = [];
  for (const b of bots) {
    const key = b.id || 'legacy';
    let markerExists = false, markerMtimeMs = 0;
    try { const st = fs.statSync(b.markerPath); markerExists = true; markerMtimeMs = st.mtimeMs; } catch (_) {}
    const v = botHealthVerdict({ activeLate: !inactiveSeen.has(key), markerExists, markerMtimeMs, restartTs });
    if (!v.healthy) unhealthy.push(`${key}:${v.reason}`);
  }
  return unhealthy.length ? { healthy: false, detail: unhealthy.join(',') } : { healthy: true };
}

// ---------- WP-G7: pre-state gate (remnant-bot fix) ----------
//
// Live repro 2026-08-10 (7 boxes): old multibot boxes keep REMNANTS of long-dead
// secondary bots — the systemd unit exists but the env file is gone ("Failed to
// load environment files"), dead for months BEFORE any pull. The post-apply
// health-gate read them as inactive_or_crashloop and reverted a HEALTHY update;
// 3 such boxes in one window tripped the fleet-wide auto-halt. Fix: snapshot
// each bot unit's state BEFORE the apply and gate only bots that were alive
// (or unknown/new-in-this-pull) pre-pull. Dead before + dead after is not a
// regression of THIS apply.

// Probe every bot's unit state before the apply. Returns {key: 'alive'|'dead'|'unknown'}.
// A probe that fails with a sudo/privilege signature proves NOTHING about the
// unit (live bot misread as down on boxes missing the NOPASSWD sudoers) → maps
// to 'unknown', which stays GATED — fail-safe: worst case is the pre-fix revert
// (already excluded from auto-halt via privilege_error), never a silent commit
// on a box we cannot actually verify.
function captureBotPreState(bots, probe) {
  const p = probe || isBotActive;
  const map = {};
  for (const b of bots) {
    const key = b.id || 'legacy';
    const errs = [];
    let active = false;
    try { active = p(b.id, errs); } catch (e) { errs.push(errText(e)); }
    map[key] = active ? 'alive' : (errs.some((t) => isPrivilegeError(t)) ? 'unknown' : 'dead');
  }
  return map;
}

// PURE: split the post-apply bot set into the bots the health-gate must judge
// (gated) and the pre-existing-dead remnants it must skip (preDead). Only a bot
// POSITIVELY dead pre-pull is skipped; 'alive', 'unknown' and a bot absent from
// the snapshot (appeared in this pull → must prove it boots) are all gated.
function partitionBotsByPreState(bots, preState) {
  const gated = [];
  const preDead = [];
  for (const b of bots) {
    const key = b.id || 'legacy';
    if (preState && preState[key] === 'dead') preDead.push(b);
    else gated.push(b);
  }
  return {
    gated,
    preDead,
    skippedNames: preDead.map((b) => b.id || 'legacy'),
    allPreexistingDead: bots.length > 0 && gated.length === 0,
  };
}

// Coordination marker so the crash-loop watchdog defers while the puller applies.
function setPullerApplyingMarker(ttlMs) {
  try {
    fs.writeFileSync(PULLER_APPLYING_MARKER, JSON.stringify({ until: Date.now() + ttlMs, pid: process.pid }));
  } catch (e) { log('WARN', `puller-applying marker write failed: ${e.message}`); }
}
function clearPullerApplyingMarker() {
  try { if (fs.existsSync(PULLER_APPLYING_MARKER)) fs.unlinkSync(PULLER_APPLYING_MARKER); } catch (_) {}
}

function cleanupOldRollbacks() {
  assertLegacyRuntimeWriter();
  if (!fs.existsSync(ROLLBACK_DIR)) return;
  const entries = fs.readdirSync(ROLLBACK_DIR).filter((f) => f.endsWith('.json'));
  if (entries.length <= MAX_ROLLBACKS) return;
  entries.sort();
  for (const e of entries.slice(0, entries.length - MAX_ROLLBACKS)) {
    try { fs.unlinkSync(path.join(ROLLBACK_DIR, e)); } catch (_) {}
    // Also prune the matching content snapshot dir (WP-G4).
    const dir = path.join(ROLLBACK_DIR, e.replace(/\.json$/, ''));
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function atomicSwitch(stagingRoot, liveRoot, assets) {
  assertLegacyRuntimeWriter();
  const movements = [];
  for (const a of assets) {
    if (a.install_method === 'npm') continue;
    const stagedAbs = path.join(stagingRoot, a.path);
    const liveAbs = resolveAssetPath(a);
    if (fs.existsSync(stagedAbs)) {
      movements.push([stagedAbs, liveAbs]);
    }
  }
  movements.sort((a, b) => b[0].length - a[0].length);
  for (const [src, dst] of movements) {
    ensureDir(path.dirname(dst));
    fs.renameSync(src, dst);
  }
}

// Remove a per-version staging subdir. `baseDir` defaults to STAGING_DIR (the
// platform staging root, under LIVE_DIR); the overlay pass passes
// OVERLAY_STAGING_DIR so its workspace-FS staging is cleaned the same way.
function cleanupStaging(version, baseDir) {
  const dir = path.join(baseDir || STAGING_DIR, version);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log('WARN', `cleanupStaging failed for ${dir}: ${e.message}`);
  }
}

// ---------- Single tick ----------

async function runTick() {
  assertLegacyRuntimeWriter();
  if (!SYNC_KEY || !BACKEND_URL) {
    log('ERROR', 'SYNC_KEY or BACKEND_URL not configured — exiting');
    return { ok: false, reason: 'no_config' };
  }

  const state = loadState();

  let manifest;
  try {
    manifest = await httpJson('GET', `${BACKEND_URL}/api/fleet/manifest`);
  } catch (e) {
    if (e.code === 'FORMAT_UNSUPPORTED') {
      log('WARN', 'server doesn\'t support manifest format v1 — skip');
      return { ok: true, reason: 'format_unsupported_fallback' };
    }
    log('ERROR', `manifest fetch failed: ${e.message}`);
    return { ok: false, reason: 'manifest_fetch_failed' };
  }

  // C4c: TWO independent passes over ONE manifest fetch.
  //   1. platform pass — bot code / CC CLI (LIVE_DIR). Unchanged behavior.
  //   2. overlay pass  — partner config/content (WORKSPACE_DIR). NEW; runs even
  //      when platform_layer is null/held (decoupled per §5.2 of the C4c design).
  // The two are isolated: one's failure must not block the other; results are
  // aggregated. INVARIANT: a manifest WITHOUT overlay_layer (the entire existing
  // fleet) takes ONLY the platform pass and returns its result byte-for-byte —
  // the overlay branch is skipped entirely, so behavior is unchanged.
  const hasOverlay = !!(manifest.overlay_layer && Array.isArray(manifest.overlay_layer.assets));

  if (!hasOverlay) {
    // Fast path == prior behavior, identical return shape.
    return runPlatformPass(manifest, state);
  }

  // Run both passes; isolate failures so one pass never blocks the other.
  let platformRes;
  try {
    platformRes = await runPlatformPass(manifest, state);
  } catch (e) {
    log('ERROR', `platform pass crashed: ${e.message}`);
    platformRes = { ok: false, reason: 'platform_pass_crashed' };
  }
  // Re-load state — runPlatformPass may have advanced applied_platform_version.
  const state2 = loadState();
  let overlayRes;
  try {
    overlayRes = await runOverlayPass(manifest, state2);
  } catch (e) {
    log('ERROR', `overlay pass crashed: ${e.message}`);
    overlayRes = { ok: false, reason: 'overlay_pass_crashed' };
  }

  return {
    ok: platformRes.ok && overlayRes.ok,
    reason: platformRes.reason,
    platform: platformRes,
    overlay: overlayRes,
    // Surface the platform version on the top-level too (circuit reporting reads it).
    version: platformRes.version,
    reverted: platformRes.reverted === true || overlayRes.reverted === true,
  };
}

// Platform pass — the ORIGINAL runTick body, verbatim. Operates on LIVE_DIR.
// Pulled into its own function so the overlay pass can run alongside it without
// duplicating or altering this code path (invariant: byte-for-byte unchanged).
async function runPlatformPass(manifest, state) {
  assertLegacyRuntimeWriter();
  const platform = manifest.platform_layer;
  if (!platform) {
    log('INFO', 'no platform_layer in manifest yet');
    return { ok: true, reason: 'no_platform_yet' };
  }

  if (platform.version === state.applied_platform_version && !platform.full_resync_required) {
    log('INFO', `already on ${platform.version}`);
    return { ok: true, reason: 'up_to_date' };
  }

  log('INFO', `target version ${platform.version} (current=${state.applied_platform_version || 'none'})`);

  // Не рвать живой ход: wait for idle BEFORE the first disk write; defer the tick if still busy.
  const deferred = await deferIfLiveTurn(state, `platform ${platform.version}`);
  if (deferred) return deferred;

  // Diff assets — compute local hashes once. Each asset's path is validated
  // by resolveAssetPath; invalid paths throw and the asset is rejected.
  const assetsToFetch = [];
  for (const a of platform.assets) {
    // WP-G6: preserve-enforce belt. Client-owned config is policy:preserve and
    // is never in the manage manifest (A0 invariant manage⇒replace). Defense-in-
    // depth: a category:"config" asset must NEVER be written by the puller —
    // skip it (not fetched → never reaches atomicSwitch). An existing file is
    // preserved; its mere presence in the manifest is a registry/build anomaly,
    // so we also raise a soft incident. (v1: skip; .env key-merge is future.)
    if (isPreservedConfig(a)) {
      let exists = false;
      try { exists = fs.existsSync(resolveAssetPath(a)); } catch (_) {}
      log('WARN', `preserve: skipping config asset ${a.path} (client-owned${exists ? ', exists' : ''}) — puller never writes config`);
      await reportIncident(platform.version, a.path, 'validate',
        `preserve: config asset in manifest skipped (client-owned${exists ? ', file present' : ''})`, 1);
      continue;
    }
    let local;
    try {
      if (a.install_method === 'npm') {
        // Always reinstall when version changes — npm handles its own state
        assetsToFetch.push(a);
        continue;
      }
      local = localHash(resolveAssetPath(a));
    } catch (e) {
      log('ERROR', `asset rejected during diff (${a.path}): ${e.message}`);
      await reportIncident(platform.version, a.path, 'validate', e.message, 1);
      return { ok: false, reason: 'asset_path_invalid' };
    }
    if (local !== normalizeHash(a.hash)) {
      assetsToFetch.push(a);
    }
  }

  if (assetsToFetch.length === 0 && !platform.full_resync_required) {
    log('INFO', 'all hashes match — just acking version');
    await ack(platform.version);
    state.applied_platform_version = platform.version;
    saveState(state);
    return { ok: true, reason: 'hash_match_only_ack' };
  }

  log('INFO', `${assetsToFetch.length} asset(s) need fetch`);

  const stagingRoot = path.join(STAGING_DIR, platform.version);
  ensureDir(stagingRoot);

  // Fetch each asset (npm runs immediately, files staged)
  for (const a of assetsToFetch) {
    const ok = await fetchAsset(a, platform.version, stagingRoot);
    if (!ok) {
      cleanupStaging(platform.version);
      return { ok: false, reason: 'fetch_failed' };
    }
  }

  // WP-G4: real content snapshot of the files we're about to replace (+ converge
  // bot/versions/ with the crash-loop watchdog). This is the rollback source.
  const snapshotDir = snapshotForRollback(state.applied_platform_version, platform.assets);

  // WP-G7: unit state of every bot BEFORE the apply — captured ahead of the
  // atomic switch so a bot dir created BY this pull is distinguishable (absent
  // from the snapshot → gated as new).
  const botPreState = captureBotPreState(enumerateBots(LIVE_DIR));

  // Tell the crash-loop watchdog to defer while we apply + health-gate so it
  // doesn't restore versions/ from under us (R5). Cleared in finally.
  setPullerApplyingMarker(PULLER_APPLYING_TTL_MS);

  try {
    // Atomic switch (file assets only; npm already applied during fetch).
    try {
      atomicSwitch(stagingRoot, LIVE_DIR, platform.assets);
    } catch (e) {
      log('ERROR', `atomic switch failed: ${e.message} — reverting`);
      revertFromSnapshot(snapshotDir, platform.assets);
      await reportIncident(platform.version, null, 'apply', `atomic switch failed: ${e.message}; reverted`, 1, true);
      return { ok: false, reason: 'atomic_switch_failed', reverted: true };
    }

    cleanupStaging(platform.version);
    cleanupOldRollbacks();

    // Graduated signal across applied assets. Heavy wins: restart > reload > none.
    const action = aggregateRestartAction(assetsToFetch);

    let skippedPreexistingDead = [];
    let allBotsPreexistingDead = false;

    if (action !== 'none') {
      // Multi-bot aware: shared code changed → restart every GATED bot on the
      // server, then health-gate that set (boots + stable + fresh per-bot marker).
      // WP-G7: a remnant dead pre-pull is neither restarted nor gated — restarting
      // it only produces incident noise, and on sudoers-hole boxes its sudo error
      // would land in probeErrors and mis-classify an HONEST revert of a live bot
      // as privilege_error (excluding a genuinely bad build from the auto-halt).
      const bots = enumerateBots(LIVE_DIR);
      const { gated, skippedNames, allPreexistingDead } = partitionBotsByPreState(bots, botPreState);
      skippedPreexistingDead = skippedNames;
      allBotsPreexistingDead = allPreexistingDead;
      if (skippedNames.length) {
        log('WARN', `health-gate: skipping preexisting-dead bot(s): ${skippedNames.join(',')}`);
      }
      const restartTs = Date.now();
      // Collect every bot-ctl.sh error text (restart + is-active probes) so a
      // health-gate revert can be classified: a sudo/privilege failure (legacy box
      // without NOPASSWD sudoers) is a FALSE revert of a live bot and must NOT count
      // toward the fleet auto-halt. Real crashes leave no privilege signature.
      const probeErrors = [];
      log('INFO', `apply action: bot-ctl.sh ${action} × ${gated.length}/${bots.length} bot(s)`);
      for (const b of gated) {
        try { botCtl(action, b.id); }
        catch (e) {
          log('ERROR', `bot ${action} (${b.id || 'legacy'}) failed: ${e.message}`);
          probeErrors.push(errText(e));
          await reportIncident(platform.version, null, action, e.message, 1);
          // fall through — the health-gate decides; revert below if unhealthy.
        }
      }

      if (gated.length === 0) {
        // Fully-dead box: every bot was already down BEFORE the pull. The file
        // update cannot have made the (already-dead) set worse and there is
        // nothing to health-gate — the apply stands, flagged in the event
        // (reverted=false → never counted toward auto-halt).
        log('WARN', `health-gate: all ${bots.length} bot(s) preexisting-dead — nothing to gate, apply stands`);
        await reportIncident(platform.version, null, 'apply',
          `health-gate skipped: all bots preexisting-dead (${skippedNames.join(',')})`, 1, false,
          { skipped_preexisting_dead: skippedNames, all_bots_preexisting_dead: true });
      } else {
        const health = await runHealthGate(gated, restartTs, probeErrors);
        if (!health.healthy) {
          // Classify BEFORE any revert restarts (whose own bot-ctl errors would be
          // pushed too, but classification only needs one privilege signature).
          const privilegeError = classifyRevertPrivilege(probeErrors);
          log('ERROR', `health-gate FAILED (${health.detail})${privilegeError ? ' [privilege_error — host missing NOPASSWD sudoers on bot-ctl.sh; live bot misread as down]' : ''} — reverting to ${state.applied_platform_version || 'previous'}`);
          revertFromSnapshot(snapshotDir, platform.assets);
          // reset-failed BEFORE restart: the crash-loop that tripped the gate may
          // have exhausted StartLimitBurst, leaving the unit `failed` where a plain
          // restart no-ops and the box stays down. See revertRestartBots.
          revertRestartBots(gated, botCtl);
          await sleep(5000);
          const stillDown = gated.filter((b) => !isBotActive(b.id)).map((b) => b.id || 'legacy');
          await reportIncident(platform.version, null, 'apply',
            `health-gate failed (${health.detail}); reverted${stillDown.length ? ', still_down=' + stillDown.join(',') : ''}`, 1, true,
            { privilege_error: privilegeError, skipped_preexisting_dead: skippedNames });
          // Do NOT advance applied version / ack — apply failed, box is on prior.
          return { ok: false, reason: 'health_gate_failed', version: platform.version, reverted: true, privilege_error: privilegeError, still_down: stillDown };
        }
        log('INFO', `health-gate passed for ${gated.length} bot(s)${skippedNames.length ? ` (skipped preexisting-dead: ${skippedNames.join(',')})` : ''}`);
        if (skippedNames.length) {
          // Visibility only (reverted=false → never counted toward auto-halt):
          // which boxes carry remnants, for the cleanup track.
          await reportIncident(platform.version, null, 'apply',
            `health-gate passed; skipped preexisting-dead bot(s): ${skippedNames.join(',')}`, 1, false,
            { skipped_preexisting_dead: skippedNames });
        }
      }

      // CC engine smoke (behind HEALTHGATE_CC_SMOKE, fail-safe). The process gate
      // above already proved the bot BOOTED and is alive; this additionally checks the
      // CC-CLI ENGINE BINARY still EXECUTES. Purpose = DETECTION, not self-heal: on a
      // definitive engine failure we do NOT revert (the CLI is an npm asset that
      // snapshot/revert skip — reverting FILE assets to N-1 would leave "old code +
      // broken engine" and could topple the live process; see section header). Instead
      // we BLOCK THE ACK (do not advance applied_platform_version), raise a distinct
      // cc_smoke_failed incident (reverted=false), and leave the ALIVE process as-is so
      // the discrepancy is visible and the version is re-evaluated next tick (bounded
      // by the circuit-breaker). Uncertain/absent/timed-out → skip, never blocks. When
      // the flag is OFF this block is skipped and behavior is byte-for-byte the prior
      // puller.
      if (ccSmokeEnabled()) {
        const smoke = runCcEngineSmoke();
        if (ccSmokeGateOutcome(smoke) === 'block') {
          log('ERROR', `CC smoke FAILED (${smoke.reason}, exit=${smoke.exitCode}) — BLOCKING ack for ${platform.version}; process left ALIVE, file assets NOT reverted (broken CLI is an npm asset; revert would not fix it)`);
          await reportIncident(platform.version, null, 'apply',
            `cc_smoke_failed (${smoke.reason}); ack blocked, process left alive, not reverted`, 1, false);
          // Do NOT ack / advance applied_platform_version — the box is NOT verified
          // good. Do NOT revert file assets or restart (would not fix an npm CLI and
          // risks toppling the still-alive process). Leave the live process untouched.
          return { ok: false, reason: 'cc_smoke_failed', version: platform.version, reverted: false };
        }
        log('INFO', `CC smoke ${smoke.status} (${smoke.reason})`);
      }
    }

    // Healthy (or no restart needed) → commit: persist version + ack (G1 sets
    // expected_bot_hash here). We only reach this on a verified-good apply.
    state.applied_platform_version = platform.version;
    saveState(state);
    await ack(platform.version);

    return {
      ok: true, reason: 'applied', version: platform.version, asset_count: assetsToFetch.length, action,
      ...(skippedPreexistingDead.length ? { skipped_preexisting_dead: skippedPreexistingDead, all_bots_preexisting_dead: allBotsPreexistingDead } : {}),
    };
  } finally {
    clearPullerApplyingMarker();
  }
}

// ---------- Overlay pass (Срез 2 / C4c) ----------
//
// Applies the partner overlay (workspace config/content) INDEPENDENTLY of the
// platform pass. Mirrors the platform machinery (diff → fetch → snapshot →
// atomic-switch → restart-by-category → health-gate → ack) but targets
// WORKSPACE_DIR and version-tracks project_version. Runs whenever the manifest
// carries overlay_layer — even when platform_layer is null/held.
async function runOverlayPass(manifest, state) {
  assertLegacyRuntimeWriter();
  const overlay = manifest.overlay_layer;
  if (!overlay || !Array.isArray(overlay.assets)) {
    return { ok: true, reason: 'no_overlay' };
  }
  const projectVersion = overlay.project_version || null;
  const overlayVersionLabel = projectVersion || 'overlay';

  // Plan the apply (pure). resolveAssetPath enforces base:"workspace" confinement
  // (C4a) — planOverlayApply additionally rejects any non-workspace base.
  const plan = planOverlayApply(overlay.assets, {
    resolvePath: (a) => resolveAssetPath(a),
    hashOf: (p) => localHash(p),
  });

  // Rejected (defense-in-depth) assets → soft incident, drop them. Does NOT fail
  // the tick: a single malformed/escaping overlay asset must not wedge the box.
  const rejected = plan.filter((p) => p.status === 'reject-path');
  for (const r of rejected) {
    log('WARN', `overlay: rejecting asset ${r.asset && r.asset.path} — ${r.reason}`);
    await reportIncident(overlayVersionLabel, r.asset && r.asset.path, 'validate',
      `overlay asset rejected: ${r.reason}`, 1);
  }

  const toApply = plan.filter((p) => p.status === 'fetch' || p.status === 'seed-missing');
  const appliedAssets = toApply.map((p) => p.asset);

  // M6: the set of paths the overlay AUTHORITATIVELY OWNS in THIS manifest (all
  // replace-policy workspace assets, regardless of whether they needed a fetch).
  // Compared against the previously-owned set (persisted in state) to find files
  // that DROPPED OUT of the template → orphans to delete. Computed once here; the
  // actual prune + state-write happen ONLY on a committed/faithful apply below
  // (never when something was rejected — a rejected manifest is not faithfully
  // representable, so we must not prune against a partial owned-set).
  const currentOwned = overlayOwnedPathsFromPlan(plan);
  const prevOwned = Array.isArray(state.overlay_owned_paths) ? state.overlay_owned_paths : [];
  const orphans = overlayOrphanPaths(prevOwned, currentOwned);

  // Cheap version short-circuit: nothing to apply. Ack the project version when it
  // advanced — but ONLY if NOTHING was rejected. A rejected asset means the box is
  // NOT faithfully on this version, so acking would falsely advance the dashboard's
  // manifest_last_applied_project_version. With rejections + no applicable assets,
  // surface via the incident already raised above and do not ack.
  if (toApply.length === 0) {
    if (rejected.length > 0) {
      return { ok: false, reason: 'overlay_all_rejected', project_version: projectVersion, rejected: rejected.length };
    }
    // All assets legitimately skipped (hash-match / seed-exists / preserve) → the
    // box's workspace already reflects this version's CONTENT. M6: but a v2 may
    // still have DROPPED a file (orphan) with no other content change → prune it
    // here even though nothing needed fetching. Owned-set tracking is persisted
    // whenever it changed, so subsequent ticks don't re-evaluate the same drop.
    const removed = pruneOverlayOrphanFiles(orphans);
    let stateDirty = false;
    if (JSON.stringify(prevOwned) !== JSON.stringify(currentOwned)) {
      state.overlay_owned_paths = currentOwned;
      stateDirty = true;
    }
    if (projectVersion && projectVersion !== state.applied_project_version) {
      await ackProject(projectVersion);
      state.applied_project_version = projectVersion;
      saveState(state); // persists both applied_project_version and owned-set
      return { ok: true, reason: 'overlay_hash_match_ack', project_version: projectVersion, rejected: 0, pruned: removed.length };
    }
    if (stateDirty) saveState(state);
    return { ok: true, reason: 'overlay_up_to_date', project_version: projectVersion, rejected: 0, pruned: removed.length };
  }

  log('INFO', `overlay: ${toApply.length} asset(s) need apply (project_version=${projectVersion || 'none'})`);

  // Overlay writes land in the workspace the engine reads mid-turn and end in a bot restart:
  // same live-turn wait/defer as the platform pass, before the first write.
  const deferredOverlay = await deferIfLiveTurn(state, `overlay ${overlayVersionLabel}`);
  if (deferredOverlay) return { ...deferredOverlay, project_version: projectVersion };

  // Stage into a workspace-FS-scoped staging root. EXDEV fix: this MUST sit on the
  // same filesystem as WORKSPACE_DIR (the atomicSwitch destination) so the staged
  // files move by an intra-fs renameSync (atomic), not a cross-device one (EXDEV).
  // OVERLAY_STAGING_DIR defaults to a hidden dir inside WORKSPACE_DIR; cleaned up
  // below exactly like the platform staging dir.
  const overlayStagingLabel = `overlay-${overlayVersionLabel}`;
  const stagingRoot = path.join(OVERLAY_STAGING_DIR, overlayStagingLabel);
  ensureDir(stagingRoot);

  for (const a of appliedAssets) {
    const ok = await fetchAsset(a, overlayVersionLabel, stagingRoot);
    if (!ok) {
      cleanupStaging(overlayStagingLabel, OVERLAY_STAGING_DIR);
      return { ok: false, reason: 'overlay_fetch_failed', project_version: projectVersion };
    }
  }

  // Snapshot the workspace files we're about to replace (rollback source). Keyed
  // under a distinct label so it never collides with a platform snapshot.
  const snapshotDir = snapshotForRollback(`overlay-${state.applied_project_version || 'pre-initial'}`, appliedAssets);

  // WP-G7: unit state of every bot BEFORE the overlay apply (same remnant-skip
  // logic as the platform pass — see captureBotPreState).
  const botPreState = captureBotPreState(enumerateBots(LIVE_DIR));

  setPullerApplyingMarker(PULLER_APPLYING_TTL_MS);
  try {
    try {
      atomicSwitch(stagingRoot, WORKSPACE_DIR, appliedAssets);
    } catch (e) {
      log('ERROR', `overlay atomic switch failed: ${e.message} — reverting`);
      revertFromSnapshot(snapshotDir, appliedAssets);
      await reportIncident(overlayVersionLabel, null, 'apply', `overlay atomic switch failed: ${e.message}; reverted`, 1, true);
      return { ok: false, reason: 'overlay_atomic_switch_failed', project_version: projectVersion, reverted: true };
    }

    cleanupStaging(overlayStagingLabel, OVERLAY_STAGING_DIR);
    cleanupOldRollbacks();

    // Restart by category: identity (persona) → reload so the running bot re-reads
    // SOUL.md; knowledge/skill/config → none (engine reads workspace per session).
    const action = aggregateOverlayRestartAction(appliedAssets);
    if (action !== 'none') {
      const bots = enumerateBots(LIVE_DIR);
      // WP-G7: same remnant-skip as the platform pass — a bot dead BEFORE this
      // overlay apply is neither bounced nor gated.
      const { gated, skippedNames } = partitionBotsByPreState(bots, botPreState);
      if (skippedNames.length) {
        log('WARN', `overlay health-gate: skipping preexisting-dead bot(s): ${skippedNames.join(',')}`);
      }
      const restartTs = Date.now();
      // Same false-revert guard as the platform pass: collect bot-ctl.sh errors so a
      // sudo/privilege failure (missing NOPASSWD sudoers) that misreads a live bot as
      // down is classified out of the auto-halt count.
      const probeErrors = [];
      log('INFO', `overlay apply action: bot-ctl.sh ${action} × ${gated.length}/${bots.length} bot(s)`);
      for (const b of gated) {
        try { botCtl(action, b.id); }
        catch (e) {
          log('ERROR', `overlay bot ${action} (${b.id || 'legacy'}) failed: ${e.message}`);
          probeErrors.push(errText(e));
          await reportIncident(overlayVersionLabel, null, action, e.message, 1);
        }
      }
      if (gated.length === 0) {
        // Fully-dead box (all bots preexisting-dead) — nothing to gate, the
        // overlay apply stands; flagged in the event (reverted=false).
        log('WARN', `overlay health-gate: all ${bots.length} bot(s) preexisting-dead — nothing to gate, apply stands`);
        await reportIncident(overlayVersionLabel, null, 'apply',
          `overlay health-gate skipped: all bots preexisting-dead (${skippedNames.join(',')})`, 1, false,
          { skipped_preexisting_dead: skippedNames, all_bots_preexisting_dead: true });
      } else {
        const health = await runHealthGate(gated, restartTs, probeErrors);
        if (!health.healthy) {
          const privilegeError = classifyRevertPrivilege(probeErrors);
          log('ERROR', `overlay health-gate FAILED (${health.detail})${privilegeError ? ' [privilege_error — host missing NOPASSWD sudoers on bot-ctl.sh]' : ''} — reverting workspace`);
          revertFromSnapshot(snapshotDir, appliedAssets);
          revertRestartBots(gated, botCtl);
          await sleep(5000);
          const stillDown = gated.filter((b) => !isBotActive(b.id)).map((b) => b.id || 'legacy');
          await reportIncident(overlayVersionLabel, null, 'apply',
            `overlay health-gate failed (${health.detail}); reverted${stillDown.length ? ', still_down=' + stillDown.join(',') : ''}`, 1, true,
            { privilege_error: privilegeError, skipped_preexisting_dead: skippedNames });
          return { ok: false, reason: 'overlay_health_gate_failed', project_version: projectVersion, reverted: true, privilege_error: privilegeError, still_down: stillDown };
        }
        log('INFO', `overlay health-gate passed for ${gated.length} bot(s)${skippedNames.length ? ` (skipped preexisting-dead: ${skippedNames.join(',')})` : ''}`);
      }
    }

    // M6: now that the new content is committed AND the box is healthy, prune the
    // overlay-owned files that DROPPED OUT of this template version (orphans), and
    // persist the new owned-set. ONLY when nothing was rejected — a rejected
    // manifest is not faithfully representable, so we must not prune (the dropped
    // path might be "missing" only because its asset was rejected, not removed).
    let pruned = [];
    if (rejected.length === 0) {
      pruned = pruneOverlayOrphanFiles(orphans);
      state.overlay_owned_paths = currentOwned;
      // saved together with applied_project_version below (single state write).
      if (!projectVersion) saveState(state); // no version-ack write would persist it otherwise
    }

    // Committed → persist project version + ack. Only after a verified-good apply,
    // and ONLY when the version was applied in FULL (no rejected assets) — a
    // partial apply must not advance the dashboard's applied-version (the box is
    // not faithfully on `projectVersion`). The applied good assets stay on disk;
    // the rejected ones already raised incidents. The tick is marked not-ok so the
    // discrepancy is visible (and re-evaluated next tick once the manifest is fixed).
    if (projectVersion && rejected.length === 0) {
      state.applied_project_version = projectVersion;
      saveState(state); // also persists state.overlay_owned_paths set just above
      await ackProject(projectVersion);
    }

    return {
      ok: rejected.length === 0,
      reason: rejected.length === 0 ? 'overlay_applied' : 'overlay_partial_rejected',
      project_version: projectVersion,
      asset_count: appliedAssets.length,
      action,
      rejected: rejected.length,
      pruned: pruned.length,
    };
  } finally {
    clearPullerApplyingMarker();
  }
}

async function fetchAsset(asset, version, stagingRoot) {
  assertLegacyRuntimeWriter();
  // min_cc_cli_version gate — skip + incident if CC CLI on VPS is older.
  if (!assetMeetsCcRequirement(asset)) {
    const installed = getCcCliVersion() || 'unknown';
    const msg = `min_cc_cli_version ${asset.min_cc_cli_version} > installed ${installed}`;
    log('WARN', `skip asset ${asset.path}: ${msg}`);
    await reportIncident(version, asset.path, 'validate', msg, 1);
    return false;
  }

  for (let attempt = 1; attempt <= PRESIGN_RETRIES; attempt++) {
    try {
      if (asset.install_method === 'npm') {
        installNpmPackage(asset.npm_package, asset.npm_version);
        return true;
      }

      const presigned = await httpJson('POST', `${BACKEND_URL}/api/fleet/asset-url`, {
        path: asset.path,
        hash: asset.hash,
      });
      if (!presigned.url) throw new Error('no url in presigned response');

      const tmpPath = path.join(stagingRoot, `.download.${Date.now()}.${Math.random().toString(36).slice(2)}`);
      ensureDir(path.dirname(tmpPath));
      await downloadToFile(presigned.url, tmpPath);

      const downloadedHash = sha256File(tmpPath);
      if (downloadedHash !== normalizeHash(asset.hash)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        throw new Error(`hash mismatch: expected ${normalizeHash(asset.hash)} got ${downloadedHash}`);
      }

      copyForStaging(tmpPath, stagingRoot, asset);
      log('INFO', `staged ${asset.path} (${asset.size_bytes || '?'}B)`);
      return true;
    } catch (e) {
      log('WARN', `fetch attempt ${attempt}/${PRESIGN_RETRIES} for ${asset.path} failed: ${e.message}`);
      if (attempt === PRESIGN_RETRIES) {
        await reportIncident(version, asset.path, 'fetch', e.message, attempt);
        return false;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1] || 5000));
    }
  }
  return false;
}

async function ack(version) {
  try {
    await httpJson('POST', `${BACKEND_URL}/api/fleet/manifest-ack`, {
      platform_layer_version: version,
      applied_at: new Date().toISOString(),
    });
    log('INFO', `acked version ${version}`);
  } catch (e) {
    log('WARN', `ack failed: ${e.message}`);
  }
}

// C4c: ack the applied PROJECT (overlay) version. Same endpoint, distinct
// layer:"project" payload → server writes client_bots.manifest_last_applied_
// project_version. Independent of the platform ack (platform ack is untouched).
async function ackProject(projectVersion) {
  try {
    await httpJson('POST', `${BACKEND_URL}/api/fleet/manifest-ack`, {
      layer: 'project',
      project_version: projectVersion,
      applied_at: new Date().toISOString(),
    });
    log('INFO', `acked project version ${projectVersion}`);
  } catch (e) {
    log('WARN', `project ack failed: ${e.message}`);
  }
}

// ---------- Circuit-breaker (WP-G3) ----------

// Pure: is the circuit currently open (tripped and still inside cooldown)?
function isCircuitOpen(state, now) {
  const openUntil = state && state.circuit_open_until ? Date.parse(state.circuit_open_until) : 0;
  return !!(openUntil && now < openUntil);
}

// Pure: given prior state, whether the just-run tick succeeded, and now(ms),
// compute the next circuit fields. `tripped` is true exactly when this call
// (re)opens the circuit → caller reports one incident. Never reached while the
// circuit is open-in-future (those ticks are skipped before runTick), so a trip
// fires at most ~once per cooldown while a box stays broken.
function nextCircuitState(state, resOk, now) {
  if (resOk) {
    return { consecutive_failures: 0, circuit_open_until: null, tripped: false };
  }
  const failures = ((state && state.consecutive_failures) || 0) + 1;
  if (failures >= CIRCUIT_FAIL_THRESHOLD) {
    return {
      consecutive_failures: failures,
      circuit_open_until: new Date(now + CIRCUIT_COOLDOWN_MS).toISOString(),
      tripped: true,
    };
  }
  return { consecutive_failures: failures, circuit_open_until: null, tripped: false };
}

// Wraps runTick with cross-tick failure accounting. The counter lives in the
// (atomically-written) state file so it survives between timer fires. A skipped
// (circuit-open) tick exits 0 so systemd doesn't treat the deliberate pause as
// a unit failure.
async function tickOnce() {
  assertLegacyRuntimeWriter();
  const now = Date.now();
  const pre = loadState();

  if (isCircuitOpen(pre, now)) {
    log('WARN', `circuit open until ${pre.circuit_open_until} — skipping tick`);
    return { ok: true, reason: 'circuit_open', circuit_open_until: pre.circuit_open_until };
  }
  if (pre.circuit_open_until) {
    log('INFO', 'circuit cooldown elapsed — half-open trial tick');
  }

  const res = await runTick();

  // Re-read state: runTick may have advanced applied_platform_version on a
  // success path. Fold in the circuit fields and persist atomically.
  const post = loadState();
  const next = nextCircuitState(post, res.ok, now);
  post.consecutive_failures = next.consecutive_failures;
  post.circuit_open_until = next.circuit_open_until;
  if (next.tripped) {
    log('ERROR', `circuit OPENED after ${next.consecutive_failures} consecutive failed ticks (last=${res.reason}) until ${next.circuit_open_until}`);
    await reportIncident(
      res.version || post.applied_platform_version || 'unknown',
      null,
      'circuit_open',
      `puller circuit opened after ${next.consecutive_failures} consecutive failed ticks; last reason=${res.reason}`,
      next.consecutive_failures,
    );
  }
  saveState(post);
  return res;
}

// ---------- Entry ----------

// Timer-driven: systemd's msb-tick@puller.service (Type=oneshot) invokes us
// once per tick. RandomizedDelaySec on the timer handles jitter. Concurrency
// safety is delegated to systemd (one active execution per Type=oneshot unit).
// Guarded by require.main so the pure helpers above can be unit-tested by
// requiring this file without auto-running a tick.
if (require.main === module) {
  (async () => {
    // open-core: не даём vendor-манифесту затереть читаемое ядро.
    try {
      const openMarker = path.join(LIVE_DIR, 'bot', 'OPEN-CORE.md');
      const openSrc = path.join(LIVE_DIR, 'bot', 'src', 'main.mjs');
      if (fs.existsSync(openMarker) || fs.existsSync(openSrc)) {
        if (process.env.MSB_ALLOW_VENDOR_PULLER !== '1') {
          log('INFO', 'open-core detected — vendor puller skipped (set MSB_ALLOW_VENDOR_PULLER=1 to override)');
          process.exit(0);
        }
        log('WARN', 'MSB_ALLOW_VENDOR_PULLER=1 — proceeding despite open-core');
      }
    } catch (_) { /* continue */ }
    log('INFO', 'puller single-tick mode (systemd timer-driven)');
    try {
      const res = await tickOnce();
      log('INFO', `result: ${JSON.stringify(res)}`);
      process.exit(res.ok ? 0 : 1);
    } catch (e) {
      log('ERROR', `tick crashed: ${e.message}\n${e.stack || ''}`);
      process.exit(1);
    }
  })();
}

// Exported for unit tests (circuit-breaker decision logic). The service path
// above does not depend on these exports.
module.exports = {
  legacyRuntimeWriterAllowed,
  isCircuitOpen, nextCircuitState, CIRCUIT_FAIL_THRESHOLD, CIRCUIT_COOLDOWN_MS,
  botHealthVerdict, enumerateBots, HEALTH_GATE_SAMPLES_MS, HEARTBEAT_MARKER_NAME,
  isPreservedConfig,
  // WP-G7 pre-state gate (remnant-bot fix): capture + partition, pure for tests.
  captureBotPreState, partitionBotsByPreState,
  // False-revert guard: privilege-error classification (sudo/permission signature
  // on bot-ctl.sh → live bot misread as down → false revert excluded from auto-halt).
  isPrivilegeError, classifyRevertPrivilege, PRIVILEGE_ERROR_RE,
  // CC engine smoke (health-gate deepening — behind HEALTHGATE_CC_SMOKE, fail-safe).
  // Pure verdict/gate helpers + the injectable runner are exported for unit tests.
  ccSmokeEnabled, ccSmokeVerdict, ccSmokeRaw, runCcEngineSmoke, ccSmokeGateOutcome,
  CC_SMOKE_TIMEOUT_MS,
  resolveAssetPathPure,
  // EXDEV fix: surfaced so tests can assert the overlay staging root resolves on
  // the same filesystem as the dst (inside WORKSPACE_DIR), not under LIVE_DIR.
  OVERLAY_STAGING_DIR, WORKSPACE_DIR, STAGING_DIR, LIVE_DIR,
  assetApplyDecision,
  revertRestartBots,
  // C4c (Срез 2) overlay-apply pure helpers
  planOverlayApply,
  overlayAssetRestartAction,
  aggregateOverlayRestartAction,
  // M6 overlay tombstone (orphan-prune) pure helpers
  overlayOwnedPathsFromPlan,
  overlayOrphanPaths,
  // H7 / M6 snapshot+revert+prune — exported for unit tests (drive against the
  // module-level ROLLBACK/LIVE/WORKSPACE dirs the test sets via env before require).
  snapshotForRollback,
  revertFromSnapshot,
  pruneOverlayOrphanFiles,
  // Orchestration entrypoints — exported for in-process integration tests only;
  // the systemd path uses tickOnce() (above), not these exports.
  // Live-turn deferral («не рвать живой ход») — pure decision + injectable waiter for tests.
  turnMarkerPaths, newestTurnMarkerAgeMs, turnDeferDecision, waitForIdleBots, deferIfLiveTurn,
  TURN_MARKER_NAME, TURN_BUSY_WINDOW_MS, TURN_WAIT_MAX_MS, TURN_WAIT_POLL_MS, TURN_DEFER_MAX,
  runTick,
  runOverlayPass,
  runPlatformPass,
};
