import fs from 'node:fs/promises';
import { mock } from 'node:test';
import { runClaudeTurn } from '../../src/agent/claude.mjs';

if (!globalThis[Symbol.for('msb.reference.networkBlocked')]) throw new Error('Network preload missing');
const scenario = process.env.ABORT_CASE;
const ac = new AbortController();
if (scenario === 'already-aborted') ac.abort();
const calls = [];
const realKill = process.kill;
let realSignals = true;
process.kill = function (pid, signal) {
  calls.push({ pid, signal, at: performance.now() });
  // After close, record hypothetical late timer signals without sending them
  // to a PID that the operating system might already have reused.
  return realSignals ? realKill.call(process, pid, signal) : true;
};
let announceReady;
const ready = new Promise((resolve) => { announceReady = resolve; });
try {
  const turn = runClaudeTurn({ prompt: 'reference prompt', cwd: process.env.HOME,
    sessionId: 'reference-existing', signal: ac.signal,
    onEvent(event) { if (event.type === 'reference_ready') announceReady(event); } });
  let ids = {};
  let started;
  if (scenario !== 'success' && scenario !== 'already-aborted') {
    ids = await ready;
    if (scenario === 'cooperative') mock.timers.enable({ apis: ['setTimeout'] });
    started = performance.now();
    ac.abort();
  }
  const result = await turn;
  const elapsedMs = started === undefined ? 0 : performance.now() - started;
  realSignals = false;
  if (scenario !== 'group') {
    if (scenario !== 'cooperative') mock.timers.enable({ apis: ['setTimeout'] });
    ac.abort();
    mock.timers.tick(10000);
    mock.timers.reset();
  }
  const records = await fs.readFile(process.env.ABORT_TRACE, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const heartbeatBefore = await fs.readFile(`${process.env.ABORT_TRACE}.heartbeat`, 'utf8').catch(() => '');
  if (scenario === 'group') await new Promise((resolve) => setTimeout(resolve, 120));
  const heartbeatAfter = await fs.readFile(`${process.env.ABORT_TRACE}.heartbeat`, 'utf8').catch(() => '');
  const spawned = await fs.readFile(`${process.env.ABORT_TRACE}.spawned`, 'utf8').catch(() => '');
  process.stdout.write(JSON.stringify({ ...ids, result, calls, elapsedMs,
    records: records.trim() ? records.trim().split('\n').map(JSON.parse) : [],
    cliSpawned: spawned.length > 0,
    heartbeatStopped: heartbeatBefore.length > 0 && heartbeatBefore === heartbeatAfter }));
} finally {
  process.kill = realKill;
  mock.timers.reset();
}
