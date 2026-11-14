// The OS component keeps its technical protocol; only its user-facing name changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeEnginesScreen } from '../src/engines/screen.mjs';
import { handleNativeEngineCallback } from '../src/engines/telegram.mjs';
import { submitRequest } from '../src/engines/request.mjs';
import { pultScreen } from '../src/telegram/screens.mjs';

const unwantedName = /helper|помощник/i;

test('engine status keeps the service value and its existing callback without the old name', () => {
  for (const snap of [null, { helper: 'msb-engine', msb: { state: 'active' } }]) {
    const view = nativeEnginesScreen({ engine: 'cc' }, snap);
    const buttons = view.keyboard.inline_keyboard.flat();
    assert.doesNotMatch(view.text, unwantedName);
    assert.ok(buttons.every(button => !unwantedName.test(button.text)));
    assert.deepEqual(buttons.map(button => button.callback_data),
      ['settings:engine:set:cc', 'eng:status', 'eng:oc:on', 'eng:oc:off', 'menu:settings']);
    if (snap) assert.match(view.text, /msb-engine/);
  }
});

test('Pult unknown and known states do not refer to the old system component name', () => {
  for (const state of [null, { installed: true, enabled: true, active: true, root: '/synthetic' }]) {
    const view = pultScreen(state);
    assert.doesNotMatch(view.text, unwantedName);
    assert.ok(view.keyboard.inline_keyboard.flat().some(button => button.callback_data === 'settings:pult:refresh'));
  }
});

test('a busy system request gives a clear message without the old name', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-labels-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'engine'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'engine', 'request'), 'synthetic');
  const env = { MSB_RUNTIME_PROFILE: 'msb', MSB_RUNTIME_ROOT: root, MSB_BOT_ID: 'default' };
  await assert.rejects(submitRequest('status', {}, env, { publishTimeoutMs: 0 }), err => {
    assert.equal(err.code, 'ENGINE_REQUEST_BUSY');
    assert.doesNotMatch(err.message, unwantedName);
    return true;
  });
});

test('engine status timeout uses the system service wording', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-labels-timeout-')));
  const names = ['MSB_RUNTIME_PROFILE', 'MSB_RUNTIME_ROOT', 'MSB_BOT_ID'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  process.env.MSB_RUNTIME_PROFILE = 'msb';
  process.env.MSB_RUNTIME_ROOT = root;
  process.env.MSB_BOT_ID = 'default';
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (String(file) === '/run/msb-engine/state.json') throw Object.assign(Error('synthetic'), { code: 'ENOENT' });
    return read(file, ...args);
  });
  let clock = 0, shown;
  t.mock.method(Date, 'now', () => clock += 30_000);
  const handled = await handleNativeEngineCallback({ data: 'eng:status', state: {},
    show: value => { shown = value; }, providerView: () => ({ activeTitle: 'Codex', choices: [] }) });
  assert.equal(handled, true);
  assert.match(shown.text, /Системная служба не ответила/);
  assert.doesNotMatch(shown.text, unwantedName);
});
