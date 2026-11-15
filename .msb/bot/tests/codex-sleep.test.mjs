/** Shared Codex sleep notice preserves injected existing buttons. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexSleep } from '../src/engines/codex-sleep.mjs';

test('the Codex pause notice keeps existing injected buttons and the switch action', async () => {
  const messages = [];
  const sleep = createCodexSleep({ pending: new Map(), extraButtons: async keyboard => {
    keyboard.url('Existing link', 'https://example.test/fixture');
  } });
  await sleep.notify({ chat: { id: 42 }, reply: async (text, options) => messages.push({ text, options }) });
  assert.match(messages[0].text, /^Codex на паузе\./);
  const buttons = messages[0].options.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(button => button.text === 'Existing link' && button.url === 'https://example.test/fixture'));
  assert.ok(buttons.some(button => button.text === '🔀 Переключить' && button.callback_data === 'eng:wake'));
});

test('an unavailable optional button never hides the wake action', async () => {
  const messages = [];
  const sleep = createCodexSleep({ pending: new Map(), extraButtons: async () => { throw Error('fixture'); } });
  await sleep.notify({ chat: { id: 42 }, reply: async (text, options) => messages.push({ text, options }) });
  assert.ok(messages[0].options.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'eng:wake'));
});
