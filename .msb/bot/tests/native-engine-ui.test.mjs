import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { nativeEnginesScreen } from '../src/engines/screen.mjs';
import { handleNativeEngineCallback } from '../src/engines/telegram.mjs';

test('bot status shows the refreshed state while Codex remains selected', () => {
  const provider = { activeTitle: 'Codex', choices: [{ text: '🧠 Codex ✓', callback_data: 'ext:conn:set:codex' }] };
  for (const status of ['disabled', 'active']) {
    const view = nativeEnginesScreen({ engine: 'cc' }, { msb: { state: status } }, provider);
    assert.ok(view.text.includes(`MSB-бот: <b>${status}</b>`));
    assert.match(view.text, /Сейчас отвечает: <b>Codex<\/b>/);
    assert.ok(view.keyboard.inline_keyboard.flat().some(button => button.callback_data === 'ext:conn:set:codex'));
  }
});

test('optional native OS screen retains helper controls and provider view', () => {
  const view = nativeEnginesScreen({ engine: 'cc' }, { helper: 'fixture', msb: { state: 'running' }, openclaw: { installed: false } },
    { activeTitle: 'Codex', choices: [{ text: '🧠 Codex ✓', callback_data: 'ext:conn:set:codex' }] });
  assert.match(view.text, /Сейчас отвечает: <b>Codex<\/b>/);
  assert.match(view.text, /MSB-бот: <b>running<\/b>/);
  assert.deepEqual(view.keyboard.inline_keyboard.flat().map(x => x.callback_data),
    ['settings:engine:set:cc', 'ext:conn:set:codex', 'eng:status', 'eng:oc:on', 'eng:oc:off', 'menu:settings']);
});

test('unknown OpenClaw installation is not shown as absent', () => {
  for (const openclaw of [{ installed: null, gateway: 'unknown' },
    { installed: true, enabled: null, gateway: 'unknown' }]) {
    const view = nativeEnginesScreen({ engine: 'cc' }, { openclaw });
    assert.match(view.text, /OpenClaw: нет данных/);
    assert.doesNotMatch(view.text, /OpenClaw: <b>не установлен<\/b>/);
  }
});

test('an off request with a still active gateway is not shown as completed', () => {
  const view = nativeEnginesScreen({ engine: 'cc' },
    { openclaw: { installed: true, enabled: false, gateway: 'active' } });
  assert.match(view.text, /OpenClaw: <b>выключение не завершено<\/b>/);
});

test('an off request with an unknown gateway is not shown as completed', () => {
  const view = nativeEnginesScreen({ engine: 'cc' },
    { openclaw: { installed: true, enabled: false, gateway: 'unknown' } });
  assert.match(view.text, /OpenClaw: <b>состояние неизвестно<\/b>/);
});

test('a running gateway does not imply its setup is complete', () => {
  for (const [incomplete, label] of [[true, /установка не завершена/], [null, /готовность неизвестна/]]) {
    const view = nativeEnginesScreen({ engine: 'cc' },
      { openclaw: { installed: true, enabled: true, gateway: 'active', incomplete } });
    assert.match(view.text, label);
  }
});

test('failed stopping remains visible even if the setup was incomplete', () => {
  const view = nativeEnginesScreen({ engine: 'cc' },
    { openclaw: { installed: true, enabled: false, gateway: 'active', incomplete: true } });
  assert.match(view.text, /выключение не завершено/);
});

test('optional OS dispatcher leaves ordinary menu callbacks untouched', async () => {
  assert.equal(await handleNativeEngineCallback({ data: 'settings:back', state: {},
    show() { throw Error('unexpected UI action'); }, providerView() { throw Error('unexpected provider read'); } }), false);
});

function restrictedCallbackFixture(t) {
  const initial = { msb: process.env.MSB_CC_ONLY, jarvis: process.env.JARVIS_CC_ONLY, readFile: fs.readFile };
  t.after(() => {
    for (const [name, value] of [['MSB_CC_ONLY', initial.msb], ['JARVIS_CC_ONLY', initial.jarvis]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.readFile = initial.readFile;
  });
  fs.readFile = async (file, ...args) => {
    if (file !== '/run/msb-engine/state.json') return initial.readFile(file, ...args);
    const error = new Error('No isolated helper state');
    error.code = 'ENOENT';
    throw error;
  };
  const provider = { activeTitle: 'Codex', choices: [{ text: '🧠 Codex ✓', callback_data: 'ext:conn:set:codex' }] };
  async function run(data, msb, jarvis) {
    process.env.MSB_CC_ONLY = msb;
    if (jarvis === undefined) delete process.env.JARVIS_CC_ONLY;
    else process.env.JARVIS_CC_ONLY = jarvis;
    let screen;
    assert.equal(await handleNativeEngineCallback({ data, state: {}, show: value => { screen = value; },
      providerView: () => provider }), true);
    return screen;
  }
  return run;
}

test('stale native OpenClaw callbacks do not claim the Codex profile is Claude-only', async (t) => {
  const run = restrictedCallbackFixture(t);
  for (const data of ['eng:add', 'eng:mig']) {
    const normal = await run(data, '1');
    assert.match(normal.text, /OpenClaw/);
    assert.doesNotMatch(normal.text, /только с 👾 Claude Code/);
    assert.ok(normal.keyboard.inline_keyboard.flat().some(button => button.callback_data === 'ext:conn:set:codex'));
  }
  const home = await run('eng:home', '1');
  assert.match(home.text, /Сейчас отвечает: <b>Codex<\/b>/);
});

test('strict Claude-only flag applies regardless of the MSB flag', async (t) => {
  const run = restrictedCallbackFixture(t);
  for (const data of ['eng:add', 'eng:mig']) {
    for (const msb of ['0', '1']) {
      const strict = await run(data, msb, '1');
      assert.match(strict.text, /только с 👾 Claude Code/);
    }
  }
});
