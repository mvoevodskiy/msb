/** Core abort → real Codex shim → app-server subprocess, with an isolated peer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runClaudeTurn } from '../src/agent/claude.mjs';
import { loadStore } from '../../../overlay/bot/ext/store.mjs';

const threadId = '01912345-1234-7123-8123-123456789abc';
const shim = new URL('../../../overlay/bot/ext/shim/run-turn.mjs', import.meta.url);
const networkGuard = new URL('../../../overlay/bot/ext/tests/reference/fixtures/network-deny.mjs', import.meta.url);
const peer = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const record = value => fs.appendFileSync(process.env.MSB_TEST_STOP_TRACE, value + '\\n');
record(process.pid);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => record(signal));
setInterval(() => record('tick'), 30);
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') reply(id, {});
  if (method === 'thread/start') reply(id, { thread: { id: '${threadId}' } });
  if (method === 'turn/start') reply(id, { turn: { id: 'fixture-turn' } });
});`;

test('Codex stop reaps a stubborn app-server even with separate native pipes', { timeout: 12_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-steer-stop-'));
  const bin = path.join(root, 'bin');
  const trace = path.join(root, 'native.log');
  const initialEnv = { ...process.env };
  const controller = new AbortController();
  let turn, peerPid;
  try {
    await fs.mkdir(bin);
    await fs.symlink(shim, path.join(bin, 'claude'));
    await fs.writeFile(path.join(bin, 'codex'), peer, { mode: 0o700 });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      HOME: root, CODEX_HOME: path.join(root, 'codex-profile'), MSB_WORKSPACE_DIR: root, MSB_BOT_ID: 'default',
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      OPENAI_API_KEY: 'fixture-only', MSB_TEST_STOP_TRACE: trace, NODE_OPTIONS: `--import=${networkGuard.href}`,
    });
    let markReady;
    const ready = new Promise(resolve => { markReady = resolve; });
    turn = runClaudeTurn({ cwd: root, prompt: 'fixture', providerId: 'codex', signal: controller.signal,
      onSteerReady: handle => { if (handle) markReady(handle); } });
    const handle = await Promise.race([ready, turn.then(() => { throw Error('Codex exited before readiness'); })]);
    peerPid = Number((await fs.readFile(trace, 'utf8')).split('\n')[0]);
    assert.ok(Number.isInteger(peerPid) && peerPid > 1);

    controller.abort();
    const result = await turn;
    const atClose = await fs.readFile(trace, 'utf8');
    await sleep(150);
    assert.equal(result.aborted, true);
    assert.equal(result.sessionId, `ext:codex:${threadId}`, 'the stopped first thread is still available to the history');
    assert.equal(handle.active, false);
    assert.equal(await fs.readFile(trace, 'utf8'), atClose, 'the native peer must stop before the core releases the turn');
    assert.match(atClose, /^SIGINT$/m);
    assert.match(atClose, /^SIGTERM$/m, 'the app-server ignored SIGINT and needs escalation');
    assert.throws(() => process.kill(peerPid, 0), { code: 'ESRCH' });
    peerPid = undefined;
    assert.equal((await loadStore()).sessions.codex, undefined, 'a stopped thread does not update the session store');
  } finally {
    controller.abort();
    if (peerPid > 1) try { process.kill(peerPid, 'SIGKILL'); } catch { /* fixture already gone */ }
    await turn?.catch(() => {});
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, initialEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
});
