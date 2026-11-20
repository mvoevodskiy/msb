/**
 * Fresh profile → real [overlay startup](../../../overlay/bot/ext/integration/startup.mjs)
 * and [Telegram ingress](../src/telegram/bot.mjs) → guarded introduction/handoff.
 * No injected provider state: the native login route owns selection in [state](../src/state.mjs).
 * Telegram transport and the [owned Codex executable](./fixtures/codex-first-start-cli.cjs) are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';

const owner = { id: 42, is_bot: false, first_name: 'Owner' };
const botInfo = { id: 99, is_bot: true, first_name: 'Fixture', username: 'first_start_fixture_bot' };
const chat = { id: owner.id, type: 'private' };
const scope = '42:42:0';
const greeting = 'Меня только что подключили к твоему серверу. Давай настроюсь — как тебя зовут и чем занимаешься?';
const introduction = '0299a213-81c0-7800-8aa1-bbab2a035a53';
const firstInput = 'Я Марина, занимаюсь каталогом растений.';
const lastInput = 'Предпочитаю краткие ответы. Заверши знакомство.';
const ordinaryInput = 'Посчитай количество папок.';
const hub = /^Готов\. Пиши задачу/;
const serviceCard = /^<b>Какие сервисы подключить\?<\/b>/;

async function waitFor(check, description) {
  const deadline = performance.now() + 5_000;
  while (!await check()) {
    if (performance.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function missing(file) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
}

test('fresh Codex setup through device login, first Telegram turn, introduction and ready hub', { timeout: 20_000 }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'msb-codex-first-start-')));
  const workspace = path.join(home, 'workspace');
  const profile = path.join(home, 'native-codex');
  const root = path.join(home, '.msb');
  const bin = path.join(home, 'bin');
  const codex = path.join(bin, 'codex');
  const tmp = path.join(home, 'tmp');
  const shim = fileURLToPath(new URL('../../../overlay/bot/ext/shim/bin/', import.meta.url));
  const previousEnv = { ...process.env };
  let bot, guardedSpawn;
  t.after(async () => {
    try { await bot?.stop(); }
    finally {
      guardedSpawn?.mock.restore();
      syncBuiltinESMExports();
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previousEnv);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home, TMPDIR: tmp, PATH: [shim, bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    BOT_TOKEN: '99:fixture-only', ADMIN_ID: String(owner.id), MSB_BOT_ID: 'default',
    MSB_RUNTIME_PROFILE: 'msb', MSB_RUNTIME_ROOT: root, MSB_WORKSPACE_DIR: workspace,
    MSB_CC_ONLY: '1', CODEX_HOME: profile,
  });
  await Promise.all([fs.mkdir(bin), fs.mkdir(tmp), fs.cp(new URL('../../../bootstrap/workspace-seed/', import.meta.url), workspace, { recursive: true })]);
  const executable = await fs.readFile(new URL('./fixtures/codex-first-start-cli.cjs', import.meta.url), 'utf8');
  await fs.writeFile(codex, `#!${process.execPath}\n${executable}`, { mode: 0o700 });
  const spawn = childProcess.spawn;
  guardedSpawn = t.mock.method(childProcess, 'spawn', (command, argv, options) => {
    assert.equal(options?.env?.HOME, home);
    assert.ok(command === 'claude' || command === codex, `Unexpected executable: ${command}`);
    return spawn(command, argv, options);
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, 'fetch', () => assert.fail('External fetch in first-run fixture'));

  // The actual overlay prepares the same grammY class that receives the updates.
  const { prepare } = await import('../../../overlay/bot/ext/install.mjs');
  const { storePath } = await import('../../../overlay/bot/ext/store.mjs');
  const { statePath } = await import('../src/paths.mjs');
  const stateFile = statePath();
  const providerFile = storePath();
  await missing(stateFile);
  await missing(providerFile);
  await missing(path.join(profile, 'auth.json'));
  await prepare();
  const { restoreProjectState } = await import('../src/projects/restore.mjs');
  await restoreProjectState();
  await missing(stateFile);
  await missing(providerFile);

  const { createBot } = await import('../src/telegram/bot.mjs');
  const { readConfig } = await import('../src/config.mjs');
  const { loadState } = await import('../src/state.mjs');
  const cfg = readConfig();
  const telegram = new Bot(cfg.botToken, { botInfo });
  const calls = [];
  let outgoingId = 1000;
  telegram.api.config.use(async (_previous, method, payload) => {
    const messageId = payload.message_id ?? ++outgoingId;
    calls.push({ method, payload, messageId });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { ok: true, result: { message_id: messageId, date: 1, chat, text: payload.text } };
    }
    assert.ok(['setMyCommands', 'answerCallbackQuery', 'deleteMessage', 'sendChatAction', 'editMessageReplyMarkup'].includes(method),
      `Unexpected Telegram API method: ${method}`);
    return { ok: true, result: true };
  });
  bot = createBot(cfg, { bot: telegram });

  let updateId = 0;
  const message = text => bot.handleUpdate({ update_id: ++updateId, message: {
    message_id: updateId, date: 1, from: owner, chat, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.length }] } : {}),
  } });
  const press = (view, data) => {
    assert.ok(view.payload.reply_markup?.inline_keyboard.flat().some(button => button.callback_data === data),
      `Expected button ${data}`);
    return bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), chat_instance: 'first-start', from: owner, data,
      message: { message_id: view.messageId, date: 1, from: botInfo, chat, text: view.payload.text },
    } });
  };
  const sent = () => calls.filter(call => call.method === 'sendMessage');
  const edited = () => calls.filter(call => call.method === 'editMessageText');
  const countSent = pattern => sent().filter(call => pattern.test(call.payload.text)).length;
  const trace = path.join(home, 'codex-trace.jsonl');
  const readTrace = async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const identity = path.join(workspace, 'SOUL.md');
  const note = path.join(workspace, 'memory', 'intro-note.md');
  const marker = path.join(workspace, '.iia-bootstrapped');
  const seed = await fs.readFile(identity, 'utf8');
  const rules = await fs.readFile(path.join(workspace, 'CLAUDE.md'), 'utf8');

  await message('/start');
  const setup = sent().at(-1);
  assert.match(setup.payload.text, /Сначала подключи AI[\s\S]*Codex/);
  const initial = (await loadState()).state;
  assert.equal(initial.chatId, chat.id);
  assert.equal(initial.ccEffort, 'xhigh');
  assert.equal(initial.extAuthBypass, undefined);
  assert.equal(initial.ccSessionId, undefined);
  await missing(providerFile);
  await missing(trace);

  await press(setup, 'setup:help:codex');
  assert.match(edited().at(-1).payload.text, /Codex[\s\S]*\/settings[\s\S]*Вход[\s\S]*ChatGPT/);
  await message('/settings');
  await press(sent().at(-1), 'settings:auth');
  await press(edited().at(-1), 'ext:auth:codex');
  assert.ok(sent().some(call => call.payload.text.includes('A7QD-XP402')));
  assert.match(sent().at(-1).payload.text, /Агент теперь на.*Codex/);
  const selected = (await loadState()).state;
  assert.equal(selected.extAuthBypass, 'codex');
  assert.equal(selected.ccSessionId, undefined);
  assert.equal(JSON.parse(await fs.readFile(providerFile, 'utf8')).active, 'codex');
  assert.deepEqual((await readTrace()).map(call => call.kind), ['device-login', 'login-status']);

  await message('/start');
  assert.equal(sent().at(-1).payload.text, greeting);
  assert.equal(sent().at(-1).payload.reply_markup, undefined);
  await message(firstInput);
  await waitFor(() => fs.access(note).then(() => true, () => false), 'the held first Codex turn');
  assert.equal((await loadState()).state.codexBootstrap[scope].turns, 1);
  assert.equal(await fs.readFile(identity, 'utf8'), seed);
  await missing(marker);
  await message('/start');
  assert.equal(sent().at(-1).payload.text, greeting);
  assert.equal(countSent(hub), 0);
  assert.equal(countSent(serviceCard), 0);
  await fs.writeFile(path.join(home, 'release-first'), 'release');
  await waitFor(() => countSent(/^Как удобнее оформлять ответы\?$/) === 1, 'the first introduction reply');
  assert.equal((await loadState()).state.codexBootstrap[scope].sessionId, `ext:codex:${introduction}`);
  assert.equal((await loadState()).state.ccSessionId, undefined);

  await message(lastInput);
  await waitFor(async () => (await loadState()).state.servicesSetupShown === true, 'completed introduction and service card');
  const answers = sent();
  const finished = answers.findIndex(call => call.payload.text === 'Знакомство завершено.');
  const services = answers.findIndex(call => serviceCard.test(call.payload.text));
  assert.ok(finished >= 0 && services > finished);
  assert.equal(countSent(serviceCard), 1);
  assert.ok(answers[services].payload.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'svc_setup:skip'));
  const completed = (await loadState()).state;
  assert.equal(completed.codexBootstrap, undefined);
  assert.equal(completed.ccSessionId, `ext:codex:${introduction}`);
  await fs.access(marker);
  assert.ok((await fs.readFile(identity, 'utf8')).startsWith(seed));
  assert.equal(await fs.readFile(path.join(workspace, 'CLAUDE.md'), 'utf8'), rules);
  assert.equal(await fs.readFile(note, 'utf8'), 'Марина ведёт каталог растений.\n');
  assert.match(await fs.readFile(path.join(workspace, 'USER.md'), 'utf8'), /- Имя: Марина/);
  assert.match(await fs.readFile(path.join(workspace, 'MEMORY.md'), 'utf8'), /- Предпочитает краткие ответы/);

  await message('/start');
  assert.match(sent().at(-1).payload.text, hub);
  assert.equal(countSent(serviceCard), 1);
  await message(ordinaryInput);
  await waitFor(() => countSent(/^Обычная задача обработана\./) === 1, 'the ordinary Codex reply');
  await bot.stop();
  assert.match(sent().find(call => /^Обычная задача обработана\./.test(call.payload.text)).payload.text, /<blockquote>⏱/);
  assert.equal(countSent(/^Обычная задача обработана\./), 1);
  assert.equal(countSent(serviceCard), 1);

  const native = await readTrace();
  assert.deepEqual(native.map(call => call.kind), ['device-login', 'login-status', 'exec', 'exec', 'exec', 'app-turn']);
  assert.ok(native.every(call => call.profile === profile));
  const [first, last, summary, ordinary] = native.slice(2);
  assert.ok([first, last, summary, ordinary].every(call => call.cwd === workspace));
  assert.deepEqual([first.resumed, last.resumed, summary.resumed, ordinary.resumed], [null, introduction, introduction, introduction]);
  assert.match(first.prompt, /первую настройку с новым владельцем/);
  assert.doesNotMatch(last.prompt, /первую настройку с новым владельцем/);
  assert.match(summary.prompt, /Верни только один JSON-объект строго вида/);
  assert.equal(summary.sandbox, 'read-only');
  assert.doesNotMatch(ordinary.prompt, /первую настройку с новым владельцем/);
  for (const [call, input] of [[first, firstInput], [last, lastInput], [ordinary, ordinaryInput]]) {
    assert.equal(call.prompt.split(input).length - 1, 1);
  }
});
