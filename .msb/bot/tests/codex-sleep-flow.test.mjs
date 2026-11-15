/** Codex ingress/queue and introduction handoff while a bot is asleep.
 * Old readable blob 73aa9e7e:109826–109879, 110229–110247. Synthetic I/O only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/menu-fixture.mjs';
import { loadState } from '../src/state.mjs';
import { createIntroPendingJournal } from '../src/agent/intro-pending.mjs';
import { handleEnginesRoute } from '../src/telegram/routes/engines.mjs';
import { isCodexSelected } from '../src/engines/codex-active.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Codex selection follows the current CLI provider state', () => {
  assert.equal(isCodexSelected({ engine: 'cc', extAuthBypass: 'codex' }), true);
  assert.equal(isCodexSelected({ extAuthBypass: 'codex' }), true);
  assert.equal(isCodexSelected({ engine: 'cc', extAuthBypass: undefined }), false);
  assert.equal(isCodexSelected(null), false);
});
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) { if (await predicate()) return; await wait(5); }
  throw Error(`Timed out: ${label}`);
}
async function sleepMarker() {
  const dir = path.join(process.env.MSB_RUNTIME_ROOT, 'engine');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, 'sleep.default');
  await fs.writeFile(marker, 'synthetic');
  return marker;
}
async function stageIntro(f) {
  const state = (await loadState()).state;
  const journal = createIntroPendingJournal();
  const id = randomUUID();
  await journal.stage({
    id, scope: '42:42:0', prompt: 'synthetic ninth message', chatId: 42, userId: 42,
    incomingMessageId: 123, statusId: 456, requireCodex: true,
    sessionId: state.ccSessionId, activeSessionId: state.ccSessionId, project: null, epoch: 0,
    profileDir: path.join(f.home, '.codex'), workspace: f.workspace, cwd: await fs.realpath(f.workspace),
  });
  return { journal, id };
}

for (const input of ['command', 'command-with-username', 'reply']) {
  test(`an active Codex turn accepts ${input} stop while the bot is asleep`, async t => {
    let started, aborted;
    const running = new Promise(resolve => { started = resolve; });
    const interrupted = new Promise(resolve => { aborted = resolve; });
    const f = await fixture(t, async ({ signal }) => {
      started();
      return new Promise(resolve => signal.addEventListener('abort', () => {
        aborted(); resolve({ ok: false, error: 'aborted' });
      }, { once: true }));
    });
    const before = (await loadState()).state;
    await f.message('synthetic ongoing request');
    await running;
    const marker = await sleepMarker();
    if (input === 'command') await f.message('/stop');
    else if (input === 'command-with-username') await f.message('/stop@fixture_bot');
    else await f.bot.handleUpdate({ message: { message_id: 100, text: 'стоп',
      from: { id: 42 }, chat: { id: 42 }, reply_to_message: { message_id: 1 } } });
    const stopped = await Promise.race([interrupted.then(() => true), wait(500).then(() => false)]);
    assert.equal(stopped, true, 'The pause must not hide the existing stop path.');
    assert.ok(f.messages.includes('Моя остановочка ✋🏽⛔️'));
    assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic', 'Stopping is not waking.');
    const after = (await loadState()).state;
    assert.equal(after.ccSessionId, before.ccSessionId);
    assert.equal(after.extAuthBypass, before.extAuthBypass);
  });
}

test('a queued Codex turn is not started when sleep begins before admission', async t => {
  let turns = 0, release, entered;
  const first = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, async () => {
    turns++;
    if (turns === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true, text: 'synthetic answer' };
  });
  const before = (await loadState()).state;
  await f.message('первый');
  await first;
  await f.message('в очереди');
  const statusId = f.messages.findIndex(text => text === '⏳ в очереди') + 1;
  assert.ok(statusId);
  await sleepMarker();
  release();
  await until(() => f.deleted.includes(statusId), 'queued status removal');
  assert.equal(turns, 1);
  await f.callback('eng:wake');
  await f.message('после пробуждения');
  await until(() => turns === 2, 'resumed turn');
  const after = (await loadState()).state;
  assert.equal(after.extAuthBypass, before.extAuthBypass);
  assert.equal(after.ccSessionId, before.ccSessionId);
});

test('a prepared Codex introduction handoff stays in the journal until wake', async t => {
  let turns = 0;
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'synthetic answer' }; });
  const marker = await sleepMarker();
  const { journal, id } = await stageIntro(f);
  await f.bot.start();
  await wait(30);
  assert.equal(turns, 0);
  assert.equal((await journal.list()).find(record => record.id === id)?.status, 'prepared');
  assert.ok(!f.deleted.includes(456));
  await f.callback('eng:wake');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  await until(() => turns === 1, 'handoff recovery');
});

test('waking while recovery is leaving the sleep gate does not strand the handoff', async t => {
  let turns = 0, release, reached;
  const hold = new Promise(resolve => { release = resolve; });
  const atGate = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, async () => { turns++; return { ok: true, text: 'synthetic answer' }; });
  await stageIntro(f);
  const controller = f.bot[Symbol.for('msb.engineSleep')];
  const queued = controller.queued;
  let first = true;
  controller.queued = async entry => {
    if (entry.recovered && first) {
      first = false;
      await sleepMarker();
      const result = await queued(entry);
      reached(); await hold;
      return result;
    }
    return queued(entry);
  };
  t.after(() => release());
  await f.bot.start();
  await atGate;
  await f.callback('eng:wake');
  release();
  await until(() => turns === 1, 'handoff after wake race');
});

test('a failed direct Codex wake reports the error without publishing a system request', async () => {
  let attempts = 0, shown;
  const sleep = { wake: async () => { attempts++; return false; },
    wakeAttempt: async () => { throw Error('system fallback must not run'); } };
  await handleEnginesRoute({ data: 'eng:wake', state: { extAuthBypass: 'codex' },
    bot: { [Symbol.for('msb.engineSleep')]: sleep }, show: async view => { shown = view; },
    engineMenu: async () => ({ keyboard: { inline_keyboard: [] } }) });
  assert.equal(attempts, 1);
  assert.match(shown.text, /Не получилось переключить/);
});

test('a different selected provider retains the existing wake route', async () => {
  let attempts = 0, shown;
  const sleep = { wakeAttempt: async () => { attempts++; return { ok: true }; } };
  await handleEnginesRoute({ data: 'eng:wake', state: { extAuthBypass: undefined },
    bot: { [Symbol.for('msb.engineSleep')]: sleep }, show: async view => { shown = view; },
    engineMenu: async () => ({ text: 'existing engine menu', keyboard: { inline_keyboard: [] } }) });
  assert.equal(attempts, 1);
  assert.equal(shown.text, 'existing engine menu');
});

for (const operation of ['stop command', 'shutdown']) {
  test(`${operation} cancels a turn while sleep admission is still pending`, async t => {
    let turns = 0, release, reached;
    const hold = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    const f = await fixture(t, async () => { turns++; return { ok: true, text: 'must not run' }; });
    const controller = f.bot[Symbol.for('msb.engineSleep')];
    controller.queued = async () => { reached(); await hold; return false; };
    try {
      await f.message('задача до остановки');
      await entered;
      if (operation === 'stop command') {
        await f.message('/stop');
        assert.ok(f.messages.includes('Моя остановочка ✋🏽⛔️'), 'Admission is cancellable work.');
        release();
        await wait(30);
        assert.equal(turns, 0);
      } else {
        const closing = f.bot.stop();
        release();
        await closing;
        assert.equal(turns, 0);
      }
    } finally { release(); }
  });
}

for (const operation of ['stop command', 'shutdown']) {
  test(`${operation} during handoff admission never launches the recovered Codex turn`, async t => {
    let turns = 0, release, reached;
    const hold = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    const f = await fixture(t, async () => { turns++; return { ok: true, text: 'must not run' }; });
    const { journal, id } = await stageIntro(f);
    const controller = f.bot[Symbol.for('msb.engineSleep')];
    controller.queued = async entry => { if (entry.recovered) { reached(); await hold; } return false; };
    try {
      await f.bot.start();
      await entered;
      if (operation === 'stop command') {
        await f.message('/stop');
        release(); await wait(30);
        assert.equal((await journal.list()).find(record => record.id === id)?.status, 'cancelled');
      } else {
        const closing = f.bot.stop();
        release(); await closing;
        assert.equal((await journal.list()).find(record => record.id === id)?.status, 'prepared');
        assert.ok(!f.deleted.includes(456));
      }
      assert.equal(turns, 0);
    } finally { release(); }
  });
}
