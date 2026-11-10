import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeEnginesScreen } from '../src/engines/screen.mjs';
import { handleNativeEngineCallback } from '../src/engines/telegram.mjs';

test('optional native OS screen retains helper controls and provider view', () => {
  const view = nativeEnginesScreen({ engine: 'cc' }, { helper: 'fixture', msb: { state: 'running' }, openclaw: { installed: false } },
    { activeTitle: 'Codex', choices: [{ text: '🧠 Codex ✓', callback_data: 'ext:conn:set:codex' }] });
  assert.match(view.text, /Сейчас отвечает: <b>Codex<\/b>/);
  assert.match(view.text, /MSB-бот: <b>running<\/b>/);
  assert.deepEqual(view.keyboard.inline_keyboard.flat().map(x => x.callback_data),
    ['settings:engine:set:cc', 'ext:conn:set:codex', 'eng:status', 'eng:oc:on', 'eng:oc:off', 'menu:settings']);
});

test('optional OS dispatcher leaves ordinary menu callbacks untouched', async () => {
  assert.equal(await handleNativeEngineCallback({ data: 'settings:back', state: {},
    show() { throw Error('unexpected UI action'); }, providerView() { throw Error('unexpected provider read'); } }), false);
});
