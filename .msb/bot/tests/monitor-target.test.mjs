import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveState } from '../src/state.mjs';
import { defaultConfig, saveMonitorConfig } from '../src/monitor/config.mjs';
import { appendItems, loadMeta } from '../src/monitor/store.mjs';
import { maybeSendDigest } from '../src/monitor/digest.mjs';

async function fixture(t, targetBotId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const primary = { MSB_RUNTIME_ROOT: root, MSB_BOT_ID: 'default' };
  const secondary = { ...primary, MSB_BOT_ID: 'SMM' };
  for (const env of [primary, secondary]) await saveState({ timezone: 'UTC' }, env);
  const cfg = defaultConfig();
  cfg.digest.hour = new Date().getUTCHours();
  if (targetBotId) cfg.digest.targetBotId = targetBotId;
  await saveMonitorConfig(cfg, primary);
  await appendItems([{ id: 'fixture', title: 'fixture', publishedAt: new Date().toISOString() }], primary);
  const deliveries = [];
  const send = (env, force = false) => maybeSendDigest({ env, force, adminId: 42,
    api: { sendMessage: async () => deliveries.push(env.MSB_BOT_ID) }, log() {} });
  return { primary, secondary, deliveries, send };
}

test('a secondary bot cannot claim the default bot scheduled digest', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T09:00:00Z') });
  for (const target of [undefined, 'default']) {
    const f = await fixture(t, target);
    assert.deepEqual(await f.send(f.secondary), { sent: false, reason: 'not-target' });
    assert.equal((await loadMeta(f.primary)).lastDigestAt, null);
    assert.equal((await f.send(f.primary)).sent, true);
    assert.equal((await f.send(f.primary)).reason, 'already');
    assert.deepEqual(f.deliveries, ['default']);
  }
});

test('an explicitly configured target and intentional forced delivery keep their routes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T09:00:00Z') });
  const f = await fixture(t, 'SMM');
  assert.equal((await f.send(f.primary)).reason, 'not-target');
  assert.equal((await f.send(f.secondary)).sent, true);
  assert.equal((await f.send(f.primary, true)).sent, true);
  assert.deepEqual(f.deliveries, ['SMM', 'default']);
});
