import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { botId, botRoot, statePath } from '../src/paths.mjs';
import { hasClaudeAuth, loadState, saveState } from '../src/state.mjs';
import { tryParseScheduleMessage, addTask, listTasks } from '../src/autonomy/store.mjs';
test('botId validates', () => {
  assert.equal(botId({ MSB_BOT_ID: 'default' }), 'default');
  assert.equal(botId({ MSB_BOT_ID: '../evil' }), 'default');
  assert.equal(botId({ MSB_BOT_ID: 'visual' }), 'visual');
});

test('state roundtrip in temp home', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-open-'));
  const env = { HOME: home, MSB_BOT_ID: 'default' };
  await saveState({ model: 'claude-opus-4-6', authMode: 'subscription', hasSubscriptionAuth: true }, env);
  const { state, file } = await loadState(env);
  assert.equal(file, statePath(env));
  assert.equal(state.model, 'claude-opus-4-6');
  assert.equal(hasClaudeAuth({}, state), true);
  assert.ok(botRoot(env).includes('.msb/bots/default'));
});

test('schedule parser', () => {
  const a = tryParseScheduleMessage('каждые 6 часов проверь диск и напиши итог');
  assert.equal(a.everyHours, 6);
  assert.match(a.prompt, /диск/);
  const b = tryParseScheduleMessage('каждые 2 дня дайджест из memory');
  assert.equal(b.everyHours, 48);
  assert.equal(tryParseScheduleMessage('привет'), null);
});

test('autonomy store', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'msb-auto-'));
  const env = { HOME: home, AUTONOMY_DIR: path.join(home, 'autonomy') };
  const t = await addTask({ prompt: 'ping', everyHours: 1, title: 'ping' }, env);
  const all = await listTasks(env);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, t.id);
});

test('model map covers families', async () => {
  const { MODEL_MAP } = await import('../src/telegram/actions.mjs');
  assert.ok(MODEL_MAP.opus.includes('opus'));
  assert.ok(MODEL_MAP.sonnet.includes('sonnet'));
});

test('hub keyboard matches closed core callbacks', async () => {
  const { hubKeyboard } = await import('../src/telegram/screens.mjs');
  const kb = hubKeyboard();
  const flat = kb.inline_keyboard.flat().map((b) => b.callback_data);
  for (const need of [
    'menu:newtask',
    'menu:projects',
    'menu:sessions',
    'menu:skills',
    'menu:agent',
    'menu:mcp',
    'menu:settings',
    'menu:autonomy',
  ]) {
    assert.ok(flat.includes(need), `missing ${need}`);
  }
});
