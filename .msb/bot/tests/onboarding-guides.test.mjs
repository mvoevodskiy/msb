/** First-run copy follows the installed login routes; no credentials or CLI are invoked. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { readEnvMap } from '../src/env/store.mjs';

async function clearAuth() {
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'MSB_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
  await saveState({});
}

const buttons = options => options.reply_markup.inline_keyboard.flat();

test('first start offers distinct Claude and Codex instructions for the installed overlay', async t => {
  const f = await fixture(t);
  await clearAuth();
  await f.message('/start');
  assert.match(f.messages.at(-1), /Claude Code[\s\S]*Codex[\s\S]*Подключени/);
  const initialButtons = buttons(f.messageOptions.at(-1));
  assert.ok(initialButtons.some(b => b.callback_data === 'setup:subscription' && /Claude/.test(b.text)));
  assert.ok(initialButtons.some(b => b.callback_data === 'setup:help' && /Claude/.test(b.text)));
  assert.ok(initialButtons.some(b => b.callback_data === 'setup:help:codex' && /Codex/.test(b.text)));
  const before = (await loadState()).state;

  await f.callback('setup:help:codex');
  assert.match(f.edits.at(-1), /Codex[\s\S]*\/settings[\s\S]*Подключени[\s\S]*Вход[\s\S]*ChatGPT/);
  assert.match(f.edits.at(-1), /код/i);
  assert.match(f.edits.at(-1), /не.*(?:чат|Telegram)/i);
  assert.ok(buttons(f.editOptions.at(-1)).some(b => b.callback_data === 'setup:back'));
  await f.callback('setup:back');
  assert.match(f.edits.at(-1), /Claude Code[\s\S]*Codex/);
  await f.callback('setup:help');
  assert.match(f.edits.at(-1), /Claude[\s\S]*claude setup-token/);
  await f.callback('setup:subscription');
  assert.match(f.edits.at(-1), /токен Claude/);
  await f.message('/start');
  assert.deepEqual((await loadState()).state, before);
  const env = (await readEnvMap()).map;
  assert.equal(env.has('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(env.has('ANTHROPIC_API_KEY'), false);
  assert.equal(await fs.stat(path.join(f.home, '.codex/auth.json')).then(() => true, () => false), false);
  assert.equal(f.restartRequests.length, 0);
});

test('opening the Codex guide cancels a pending Claude token form', async t => {
  const f = await fixture(t);
  await clearAuth();
  await f.message('/start');
  await f.callback('setup:subscription');
  await f.callback('setup:help:codex');
  await f.message('Проверка');
  assert.match(f.messages.at(-1), /Сначала подключи AI/);
  assert.equal(f.deleted.includes(99), false, 'ordinary text is not consumed as a Claude token');
  assert.equal((await readEnvMap()).map.has('CLAUDE_CODE_OAUTH_TOKEN'), false);
});

test('plain core and Claude-only mode do not offer unavailable Codex setup', async t => {
  for (const mode of ['plain', 'claude-only']) {
    await t.test(mode, async t => {
      const f = await fixture(t, undefined, { overlay: mode !== 'plain' });
      await clearAuth();
      if (mode === 'claude-only') process.env.JARVIS_CC_ONLY = '1';
      await f.message('/start');
      assert.doesNotMatch(f.messages.at(-1), /Codex/);
      assert.equal(buttons(f.messageOptions.at(-1)).some(b => b.callback_data === 'setup:help:codex'), false);
      await f.callback('setup:help:codex');
      assert.doesNotMatch(f.edits.at(-1), /Codex/);
    });
  }
});
