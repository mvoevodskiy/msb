/**
 * The final introduction card through the production callback and form ingress.
 * Old master 00f081f, readable blob 73aa9e7e, worker 110888–110897, fh 111476–111509,
 * callback 122126–122159 and text ingress 119091–119117.
 * Native model work and Telegram delivery are faked. Env and bot state are real temporary files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { envFilePath, readEnvMap } from '../src/env/store.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { setPendingAuth } from '../../../overlay/bot/ext/auth.mjs';

const header = '<b>Какие сервисы подключить?</b>';
const skipText = 'Готово! Сервисы можно добавить в любое время через /settings → 🔑';
const keys = [
  'OPENROUTER_API_KEY', 'X_BEARER_TOKEN', 'DEEPGRAM_API_KEY', 'VOYAGE_API_KEY',
  'GITHUB_TOKEN', 'SUPABASE_URL', 'RAILWAY_TOKEN', 'VERCEL_TOKEN',
];

async function serviceFixture(t, runTurn) {
  const f = await fixture(t, runTurn);
  for (const key of keys) delete process.env[key];
  return f;
}

function callbacks(options) {
  return options.reply_markup.inline_keyboard.map(row => row.map(button => button.callback_data));
}

test('the old card keeps its service order, accepts only listed keys and writes to the current bot', async t => {
  const f = await serviceFixture(t);
  const { state } = await loadState();
  const before = { ...state, lastCcUsage: { sessionId: state.ccSessionId, contextTokens: 42 } };
  await saveState(before);
  const ownEnv = envFilePath();
  const otherEnv = envFilePath({ ...process.env, MSB_BOT_ID: 'other' });
  await fs.mkdir(path.dirname(otherEnv), { recursive: true });
  await fs.writeFile(otherEnv, 'GITHUB_TOKEN=fixture-other-bot\n');
  await fs.writeFile(ownEnv, 'DEEPGRAM_API_KEY=fixture-voice-key\n');

  await f.callback('svc_setup:back');
  assert.ok(f.edits.at(-1)?.startsWith(header));
  assert.match(f.edits.at(-1), /✔ 🎤 Голосовые/);
  assert.doesNotMatch(f.edits.at(-1), /fixture-voice-key/);
  const selectable = keys.filter(key => key !== 'DEEPGRAM_API_KEY').map(key => 'svc_setup:' + key);
  assert.deepEqual(callbacks(f.editOptions.at(-1)), [
    selectable.slice(0, 3), selectable.slice(3, 6), selectable.slice(6), ['svc_setup:skip'],
  ]);

  await f.callback('svc_setup:BOT_TOKEN');
  assert.equal(f.edits.length, 1);
  await f.callback('svc_setup:GITHUB_TOKEN', 13);
  assert.equal(f.edits.length, 1);
  await f.callback('svc_setup:GITHUB_TOKEN');
  assert.match(f.edits.at(-1), /Вставь ключ <code>GITHUB_TOKEN<\/code>:/);
  assert.deepEqual(callbacks(f.editOptions.at(-1)), [['svc_setup:back']]);
  await f.message('  fixture-own-github  ');
  assert.ok(f.deleted.includes(99));
  assert.equal((await readEnvMap()).map.get('GITHUB_TOKEN'), 'fixture-own-github');
  assert.equal(await fs.readFile(otherEnv, 'utf8'), 'GITHUB_TOKEN=fixture-other-bot\n');
  assert.equal((await loadState()).state.ccSessionId, before.ccSessionId);
  assert.deepEqual((await loadState()).state.lastCcUsage, before.lastCcUsage);
  await assert.rejects(fs.stat(path.join(f.home, '.git-credentials')), { code: 'ENOENT' });
  assert.match(f.messages.at(-1), /✔ 🐙 GitHub/);
  assert.ok(f.messages.at(-1).startsWith(header));
  assert.doesNotMatch(f.messages.concat(f.edits).join('\n'), /fixture-own-github|fixture-other-bot/);
  assert.ok(!callbacks(f.messageOptions.at(-1)).flat().includes('svc_setup:GITHUB_TOKEN'));
});

test('Back, Skip and invalid values release the service form without changing .env', async t => {
  let modelCalls = 0;
  const called = Promise.withResolvers();
  const f = await serviceFixture(t, async () => {
    modelCalls++;
    called.resolve();
    return { ok: true, text: 'ordinary reply' };
  });
  await f.callback('svc_setup:VOYAGE_API_KEY');
  await f.callback('svc_setup:back');
  assert.ok(f.edits.at(-1)?.startsWith(header));
  await f.callback('svc_setup:RAILWAY_TOKEN');
  await f.callback('svc_setup:skip');
  assert.equal(f.edits.at(-1), skipText);
  assert.deepEqual(callbacks(f.editOptions.at(-1)), []);
  await f.callback('svc_setup:VERCEL_TOKEN');
  await f.message('1234');
  assert.match(f.messages.at(-1), /слишком короткий|некорректный/i);
  assert.equal(modelCalls, 0);
  assert.equal((await readEnvMap()).map.size, 0);
  await f.message('ordinary after cancellation');
  await called.promise;
  assert.equal(modelCalls, 1);
});

test('an older card and unrelated Telegram topic cannot consume an open service form', async t => {
  const prompts = [];
  const called = Promise.withResolvers();
  const f = await serviceFixture(t, async ({ prompt }) => {
    prompts.push(prompt);
    called.resolve();
    return { ok: true, text: 'ordinary reply' };
  });
  await f.callback('svc_setup:VERCEL_TOKEN', 42, { messageId: 73, threadId: 17 });
  await f.callback('svc_setup:skip', 42, { messageId: 41, threadId: 17 });
  await f.message('fixture unrelated request');
  assert.equal((await readEnvMap()).map.size, 0);
  assert.equal(f.edits.length, 2);
  await called.promise;
  assert.equal(prompts.length, 1);
  await f.bot.handleUpdate({ message: {
    message_id: 98, text: 'fixture-topic-token', from: { id: 42 }, chat: { id: 42 }, message_thread_id: 17,
  } });
  assert.equal((await readEnvMap()).map.get('VERCEL_TOKEN'), 'fixture-topic-token');
  assert.ok(f.deleted.includes(98));
  assert.ok(!f.deleted.includes(99));
  assert.equal(f.messageOptions.at(-1)?.message_thread_id, 17);
  assert.equal(prompts.length, 1);
});

test('the owner can retry a failed card delivery on /start without another introduction', async t => {
  const f = await serviceFixture(t, async () => assert.fail('a ready workspace needs no native turn'));
  const { state } = await loadState();
  await saveState({ ...state, codexServiceSetup: { scope: '42:42:0' } });
  const send = f.bot.api.sendMessage;
  let attempts = 0;
  t.mock.method(f.bot.api, 'sendMessage', async (chatId, text, ...args) => {
    if (text.startsWith(header) && ++attempts === 1) throw new Error('fixture transport failure');
    return send(chatId, text, ...args);
  });

  await f.message('/start');
  assert.equal(attempts, 1);
  assert.equal((await loadState()).state.servicesSetupShown, undefined);
  await Promise.all([f.message('/start'), f.message('/start')]);
  assert.equal(attempts, 2);
  assert.equal(f.messages.filter(text => text.startsWith(header)).length, 1);
  assert.equal((await loadState()).state.servicesSetupShown, true);
  assert.equal((await loadState()).state.codexServiceSetup, undefined);
});

test('the service form owns input before the prompt edit is acknowledged', async t => {
  const f = await serviceFixture(t, async () => assert.fail('a service key is not a model request'));
  setPendingAuth(42, 'codex', 42);
  const editing = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  const edit = f.bot.api.editMessageText;
  t.mock.method(f.bot.api, 'editMessageText', async (...args) => {
    await edit(...args);
    editing.resolve();
    await acknowledge.promise;
  });
  const remove = t.mock.method(f.bot.api, 'deleteMessage', async () => {
    throw new Error('fixture lacks permission to delete the submitted key');
  });
  const selection = f.callback('svc_setup:VOYAGE_API_KEY');
  try {
    await editing.promise;
    await f.message('fixture-early-key');
    assert.equal((await readEnvMap()).map.get('VOYAGE_API_KEY'), 'fixture-early-key');
    assert.equal(remove.mock.callCount(), 1);
  } finally {
    acknowledge.resolve();
    await selection;
  }
});

test('retry records an already delivered card after a state write failure', async t => {
  const f = await serviceFixture(t);
  const { file, state } = await loadState();
  await saveState({ ...state, codexServiceSetup: { scope: '42:42:0' } });
  const rename = fs.rename;
  const cards = () => f.messages.filter(text => text.startsWith(header));
  let failed = false;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === file && cards().length && !failed) {
      failed = true;
      throw Object.assign(new Error('fixture state write failure'), { code: 'EACCES' });
    }
    return rename(source, destination);
  });

  await f.message('/start');
  assert.equal(failed, true);
  assert.equal(cards().length, 1);
  assert.equal((await loadState()).state.servicesSetupShown, undefined);
  await f.message('/start');
  assert.equal(cards().length, 1);
  assert.equal((await loadState()).state.servicesSetupShown, true);
});
