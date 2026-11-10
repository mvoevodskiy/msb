import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { enginesScreen } from '../src/telegram/screens.mjs';
import { buildEngineProviderView, registerEngineProviderView } from '../../../overlay/bot/ext/engine-menu.mjs';

async function fixture(t, active = 'codex') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-menu-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  const directory = path.join(home, '.msb/bots/default');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'ext-providers.json');
  await fs.writeFile(file, JSON.stringify({ active, models: { codex: 'fixture-model' }, efforts: { codex: 'xhigh' } }));
  return { home, env, file };
}

test('engine view reads canonical CLI selection without modifying settings or assuming auth is valid', async t => {
  const { home, env, file } = await fixture(t);
  const before = await fs.readFile(file, 'utf8');
  const view = await buildEngineProviderView({ engine: 'cc', extAuthBypass: 'cursor' }, env, home);
  assert.equal(view.activeTitle, 'Codex');
  assert.deepEqual(view.choices, [{ text: '🧠 Codex ✓', callback_data: 'ext:conn:set:codex' }]);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.stat(path.join(home, '.codex')).then(() => true, () => false), false);
  const oc = await buildEngineProviderView({ engine: 'oc' }, env, home);
  assert.equal(oc.activeTitle, 'OpenClaw');
  assert.equal(oc.choices[0].text, '🧠 Codex');
  assert.equal(await buildEngineProviderView({}, { ...env, JARVIS_CC_ONLY: '1' }, home), null);
});

test('engine screen preserves baseline controls and renders the same optional Codex row with helper snapshots', async t => {
  const { home, env } = await fixture(t);
  const state = { engine: 'cc' };
  const provider = await buildEngineProviderView(state, env, home);
  for (const snap of [null, { helper: 'fixture', msb: { state: 'running' }, openclaw: { installed: false } }, { error: 'NO_STATE' }]) {
    const base = await enginesScreen(state, env);
    const extended = await enginesScreen(state, env, provider);
    const buttons = extended.keyboard.inline_keyboard.flat();
    assert.deepEqual(buttons.filter(b => b.callback_data !== 'ext:conn:set:codex'), base.keyboard.inline_keyboard.flat());
    assert.equal(buttons.filter(b => b.callback_data === 'ext:conn:set:codex').length, 1);
    assert.match(extended.text, /Сейчас отвечает: <b>Codex<\/b>/);
    assert.ok(buttons.some(b => b.callback_data === 'settings:engine:set:cc'));
    assert.ok(buttons.some(b => b.callback_data === 'menu:settings'));
  }
});

test('core without the extension has no unsupported Codex callback; bridge belongs to the installed Bot class', async t => {
  const { env } = await fixture(t);
  class Installed {};
  class Standalone {};
  registerEngineProviderView(Installed, { JARVIS_CC_ONLY: '1' });
  assert.equal(typeof new Installed()[Symbol.for('msb.engineProviderView')], 'function');
  assert.equal(new Standalone()[Symbol.for('msb.engineProviderView')], undefined);
  assert.equal(await new Installed()[Symbol.for('msb.engineProviderView')]({}), null);
  const view = await enginesScreen({ engine: 'cc' }, env);
  assert.ok(!view.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'ext:conn:set:codex'));
});
