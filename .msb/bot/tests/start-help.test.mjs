/**
 * Current Codex Telegram command ingress with an owned temporary workspace.
 * [Handlers](../src/telegram/bot.mjs), [catalogue](../src/telegram/commands.mjs),
 * [provider forms](../../../overlay/bot/ext/integration/text-input.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState, saveState, updateState } from '../src/state.mjs';
import { INPUT_TTL_MS } from '../shared/input-notices.mjs';
import { clearPendingAuth, getPendingAuth, setPendingAuth } from '../../../overlay/bot/ext/auth.mjs';
import { clearPendingLocalIp, getPendingLocalIp, setPendingLocalIp } from '../../../overlay/bot/ext/local-ssh.mjs';

const hub = /^Готов\. Пиши задачу или выбери действие\./;
const active = 'ext:codex:0199a213-81c0-7800-8aa1-bbab2a035a53';
const owner = 42;

test('active Codex start opens the old hub and publishes only commands with handlers', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'SOUL.md'), 'fixture configured workspace');
  const {state: before} = await loadState();
  const store = await fs.readFile(f.storeFile, 'utf8');
  await f.message('/start', owner + 1);
  assert.deepEqual(f.messages, []);
  await f.message('/start');
  assert.match(f.messages.at(-1), hub);
  assert.deepEqual(f.messageOptions.at(-1).reply_markup.inline_keyboard.map(row => row.map(button => button.callback_data)), [
    ['menu:newtask', 'menu:projects'], ['menu:sessions', 'menu:skills'],
    ['menu:agent', 'menu:mcp'], ['menu:settings', 'menu:autonomy'],
  ]);
  const [commands] = f.commandMenus;
  const published = commands.map(item => item.command);
  assert.equal(new Set(published).size, published.length);
  for (const command of published) assert.ok(f.bot.commands.has(command), command);
  for (const command of ['start', 'help', 'stop', 'compact', 'projects', 'sessions', 'pult']) {
    assert.ok(published.includes(command), command);
  }
  assert.equal(published.includes('openclaw'), false);
  const {state: after} = await loadState();
  assert.equal(after.ccSessionId, before.ccSessionId);
  assert.equal(after.extAuthBypass, 'codex');
  assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
});

for (const [kind, command] of [['auth', '/start'], ['local IP', '/help']]) {
  test('expired ' + kind + ' form does not intercept ' + command, async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.workspace, 'SOUL.md'), 'fixture configured workspace');
    let clock = 1_000_000;
    t.mock.method(Date, 'now', () => clock);
    t.after(() => { clearPendingAuth(owner); clearPendingLocalIp(owner); });
    if (kind === 'auth') setPendingAuth(owner, 'cursor', owner);
    else setPendingLocalIp(owner, { chatId: owner });
    clock += INPUT_TTL_MS + 1;
    const store = await fs.readFile(f.storeFile, 'utf8');

    await f.message(command);

    assert.match(f.messages.at(-1), command === '/start' ? hub : /^<b>Как работать<\/b>/);
    assert.equal(getPendingAuth(owner, { includeExpired: true }), null);
    assert.equal(getPendingLocalIp(owner, { includeExpired: true }), null);
    assert.equal((await loadState()).state.ccSessionId, active);
    assert.equal(await fs.readFile(f.storeFile, 'utf8'), store);
  });
}

const gate = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('start uses the Codex readiness committed ahead of it in the profile queue', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace, 'SOUL.md'), 'fixture configured workspace');
  await saveState({ engine: 'cc', userId: owner, chatId: owner });
  const { file } = await loadState();
  const entered = gate(), release = gate(), unqueuedRead = gate();
  const selection = updateState(async state => {
    entered.resolve();
    await release.promise;
    return { ...state, extAuthBypass: 'codex', authMode: 'subscription',
      hasSubscriptionAuth: true, ccSessionId: active };
  });
  await entered.promise;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (target, ...args) => {
    const bytes = await readFile(target, ...args);
    if (String(target) === file) unqueuedRead.resolve();
    return bytes;
  });
  const queue = globalThis[Symbol.for('msb.stateUpdates')];
  let start;
  try {
    start = f.bot.commands.get('start')({
      chat: { id: owner }, from: { id: owner },
      reply: (text, options) => f.bot.api.sendMessage(owner, text, options),
    });
    // A pre-transaction read sees the old unconfigured snapshot. The fixed
    // handler queues synchronously and reads only once the selection commits.
    if (queue.get(file) === selection) await unqueuedRead.promise;
  } finally {
    release.resolve();
  }
  await Promise.all([selection, start]);
  assert.match(f.messages.at(-1), hub);
  assert.equal((await loadState()).state.ccSessionId, active);
});

test('active Codex help describes recovery as instructions and keeps the connected and fallback commands', async t => {
  const f = await fixture(t);
  const { file } = await loadState();
  const before = await fs.readFile(file, 'utf8');
  await f.message('/help');
  const help = f.messages.at(-1);
  assert.match(help, /^<b>Как работать<\/b>/);
  assert.equal(f.messageOptions.at(-1).parse_mode, 'HTML');
  assert.match(help, /\/connect[^\n]+инструкц/i);
  assert.match(help, /\/recovery[^\n]+инструкц/i);
  assert.match(help, /\/undo[^\n]+пока не подключено/i);
  assert.match(help, /\/autostatus[^\n]+история фоновых прогонов/i);
  assert.doesNotMatch(help, /\/context|\/tools|\/commands/);
  await f.message('/recovery');
  assert.match(f.messages.at(-1), /существующее SSH-подключение или консоль хостера/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('inline and prompted feedback reach the same workspace writer without a model turn', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'unexpected' }; });
  const { file: stateFile } = await loadState();
  const state = await fs.readFile(stateFile, 'utf8');
  const report = path.join(f.workspace, 'ops', 'feedback.md');
  await f.message('/feedback Отзыв в команде');
  assert.equal(f.messages.at(-1), 'Спасибо, записал.');
  assert.match(await fs.readFile(report, 'utf8'), /Отзыв в команде/);
  await f.message('/feedback');
  assert.match(f.messages.at(-1), /Напиши отзыв следующим сообщением/);
  await f.message('Отзыв из формы');
  const saved = await fs.readFile(report, 'utf8');
  assert.equal(saved.match(/Отзыв в команде/g)?.length, 1);
  assert.equal(saved.match(/Отзыв из формы/g)?.length, 1);
  assert.equal(await fs.readFile(stateFile, 'utf8'), state);
  assert.equal(turns, 0);
});
