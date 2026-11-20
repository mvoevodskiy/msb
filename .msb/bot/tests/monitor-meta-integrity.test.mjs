/**
 * Corrupt/read-failed monitor metadata must not be replaced by defaults during
 * [poll/digest updates](../src/monitor/store.mjs). All profiles and delivery
 * callbacks are synthetic. Old reference and scope are documented separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorDir, loadMonitorConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { appendItems, loadMeta, saveMeta, updateMeta } from '../src/monitor/store.mjs';
import { maybeSendDigest } from '../src/monitor/digest.mjs';
import { saveState } from '../src/state.mjs';
import { monitorScreen } from '../src/telegram/screens/monitor.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-meta-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { MSB_RUNTIME_ROOT: root, MSB_BOT_ID: 'default' };
  const file = path.join(monitorDir(env), 'meta.json');
  return { env, file };
}

test('a genuinely missing meta file still initializes normally', async t => {
  const { env } = await fixture(t);
  assert.deepEqual(await loadMeta(env), { lastPollAt: {}, lastDigestAt: null });
  await updateMeta(meta => { meta.lastPollAt.fixture = '2026-11-16T09:00:00.000Z'; }, env);
  assert.equal((await loadMeta(env)).lastPollAt.fixture, '2026-11-16T09:00:00.000Z');
});

test('corrupt metadata is preserved and cannot trigger a scheduled duplicate', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T09:15:00.000Z') });
  const { env, file } = await fixture(t);
  await saveState({ timezone: 'UTC' }, env);
  const cfg = await loadMonitorConfig(env);
  cfg.digest.enabled = true;
  cfg.digest.hour = 9;
  await saveMonitorConfig(cfg, env);
  await appendItems([{ id: 'fixture-item', title: 'fixture', publishedAt: new Date().toISOString() }], env);
  const original = '{"lastDigestAt":"2026-11-16T09:00:00.000Z",';
  await fs.writeFile(file, original);
  let delivered = 0;
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await maybeSendDigest({ api: { sendMessage: async () => { delivered++; } }, adminId: 42, env, log() {} });
    } catch (error) { errors.push(error.name); }
  }
  assert.deepEqual({ errors, delivered, unchanged: (await fs.readFile(file, 'utf8')) === original },
    { errors: ['SyntaxError', 'SyntaxError'], delivered: 0, unchanged: true });
});

test('non-object metadata cannot silently send a scheduled digest twice', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T09:15:00.000Z') });
  const { env, file } = await fixture(t);
  await saveState({ timezone: 'UTC' }, env);
  const cfg = await loadMonitorConfig(env);
  cfg.digest.enabled = true;
  cfg.digest.hour = 9;
  await saveMonitorConfig(cfg, env);
  await appendItems([{ id: 'fixture-item', title: 'fixture', publishedAt: new Date().toISOString() }], env);
  const original = '[]';
  await fs.writeFile(file, original);
  let delivered = 0;
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await maybeSendDigest({ api: { sendMessage: async () => { delivered++; } }, adminId: 42, env, log() {} });
    } catch (error) { errors.push(error.name); }
  }
  assert.deepEqual({ errors, delivered, unchanged: (await fs.readFile(file, 'utf8')) === original },
    { errors: ['TypeError', 'TypeError'], delivered: 0, unchanged: true });
});

test('a metadata read error cannot be mistaken for an empty state during an update', async t => {
  const { env, file } = await fixture(t);
  await saveMeta({ lastPollAt: { fixture: 'known' }, lastDigestAt: '2026-11-16T09:00:00.000Z' }, env);
  const before = await fs.readFile(file, 'utf8');
  const realRead = fs.readFile.bind(fs);
  const read = t.mock.method(fs, 'readFile', async (target, ...args) => {
    if (String(target) === file) throw Object.assign(new Error('synthetic read failure'), { code: 'EIO' });
    return realRead(target, ...args);
  });
  let called = false, errorCode;
  try { await updateMeta(() => { called = true; }, env); } catch (error) { errorCode = error.code; }
  read.mock.restore();
  assert.deepEqual({ errorCode, called, unchanged: (await fs.readFile(file, 'utf8')) === before },
    { errorCode: 'EIO', called: false, unchanged: true });
});

test('read-only monitor views keep their existing empty-metadata fallback', async t => {
  const { env, file } = await fixture(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{invalid');
  assert.deepEqual(await loadMeta(env), { lastPollAt: {}, lastDigestAt: null });
  const previousRoot = process.env.MSB_RUNTIME_ROOT;
  process.env.MSB_RUNTIME_ROOT = env.MSB_RUNTIME_ROOT;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.MSB_RUNTIME_ROOT;
    else process.env.MSB_RUNTIME_ROOT = previousRoot;
  });
  const screen = await monitorScreen();
  assert.match(screen.text, /Мониторинг/);
  const actions = screen.keyboard.inline_keyboard.flat().map(button => button.callback_data);
  for (const action of ['mon:sources', 'mon:digest', 'mon:settings', 'mon:help']) assert.ok(actions.includes(action));
  assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
});
