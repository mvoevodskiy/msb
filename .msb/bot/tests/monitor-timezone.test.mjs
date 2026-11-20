import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { appendItems, loadMeta, saveMeta } from '../src/monitor/store.mjs';
import { maybeSendDigest } from '../src/monitor/digest.mjs';
import { saveState } from '../src/state.mjs';

async function fixture(t, timezone, hour, initial) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-timezone-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root };
  const OriginalDate = globalThis.Date;
  let now = OriginalDate.parse(initial);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  t.after(() => { globalThis.Date = OriginalDate; });
  await saveState({ timezone }, env);
  const cfg = await loadMonitorConfig(env);
  cfg.digest.hour = hour;
  await saveMonitorConfig(cfg, env);
  await appendItems([{ id: 'item', title: 'fixture', publishedAt: new Date().toISOString() }], env);
  const messages = [];
  const send = (force = false) => maybeSendDigest({ api: { sendMessage: async (...args) => messages.push(args) }, adminId: 42, force, env, log() {} });
  return { env, messages, send, setTime: (value) => { now = OriginalDate.parse(value); } };
}

test('a non-integer timezone sends once per local day across UTC midnight', async (t) => {
  const f = await fixture(t, 'Australia/Darwin', 9, '2026-11-06T23:40:00Z');
  assert.equal((await f.send()).sent, true);
  f.setTime('2026-11-07T00:01:00Z');
  assert.equal((await f.send()).reason, 'already');
  f.setTime('2026-11-07T23:40:00Z');
  assert.equal((await f.send()).sent, true);
  assert.equal(f.messages.length, 2);
});

test('the repeated DST hour does not send the same local day twice', async (t) => {
  const f = await fixture(t, 'America/New_York', 1, '2026-11-01T05:10:00Z');
  assert.equal((await f.send()).sent, true);
  f.setTime('2026-11-01T06:10:00Z');
  assert.equal((await f.send()).reason, 'already');
  assert.equal(f.messages.length, 1);
});

test('invalid stored date does not block delivery and forced delivery still works', async (t) => {
  const f = await fixture(t, 'Europe/Moscow', 9, '2026-11-06T06:00:00Z');
  await saveMeta({ lastPollAt: {}, lastDigestAt: 'invalid' }, f.env);
  assert.equal((await f.send()).sent, true);
  assert.equal((await f.send()).reason, 'already');
  assert.equal((await f.send(true)).sent, true);
  assert.equal((await loadMeta(f.env)).lastDigestAt, '2026-11-06T06:00:00.000Z');
});
