/**
 * Actual reminder/interval schedulers keep the next run visible in Telegram history
 * after an interrupted JSONL append. The old iQ writer has the same framing defect:
 * git show 73aa9e7e850bad7ac1ea8a8091d086ecbfd47a11 | sed -n '10824,10836p;24883,24949p'
 * This repairs storage integrity, without changing scheduling or delivery policy.
 * All profiles, model results and Telegram sends are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { readRecentRuns } from '../src/autonomy/history.mjs';
import { appendSavedActionRun, reminderRunPath } from '../src/autonomy/reminder-runs.mjs';
import { autonomyDir } from '../src/paths.mjs';
import { fixture } from './helpers/menu-fixture.mjs';
import { reminderFixture, scheduledAt } from './helpers/reminder-registration-fixture.mjs';

const tails = ['interrupted', 'complete without newline', 'complete with newline', 'empty', 'absent'];
const previousAt = '2026-11-01T10:00:00.000Z';

async function prepareTail(file, tail, previous) {
  const prefix = tail === 'interrupted' ? '{"unfinished":'
    : tail === 'complete without newline' ? JSON.stringify(previous)
      : tail === 'complete with newline' ? JSON.stringify(previous) + '\n' : '';
  if (tail !== 'absent') {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, prefix, { mode: 0o600 });
  }
  return prefix;
}

async function assertHistory(f, file, tail, prefix, id, previousId, label) {
  const { runs, malformed } = await readRecentRuns();
  const expected = tail.startsWith('complete') ? [id, previousId] : [id];
  assert.deepEqual(runs.map(row => row.taskId), expected, 'a completed run must remain a separate readable record');
  assert.equal(malformed, tail === 'interrupted' ? 1 : 0);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.startsWith(prefix), 'existing bytes are retained');
  assert.equal(raw.slice(prefix.length).startsWith('\n'), Boolean(prefix && !prefix.endsWith('\n')));
  await f.callback('auto:history');
  assert.match(f.edits.at(-1), label);
  assert.match(f.edits.at(-1), /✅ готово/);
  return raw;
}

for (const tail of tails) {
  test(`a delivered reminder survives journal tail: ${tail}`, async t => {
    const f = await reminderFixture(t);
    await f.request('Напомни через 30 минут проверить почту');
    await f.final();
    const [action] = await f.records();
    const file = reminderRunPath();
    const previous = { ts: previousAt, actionId: 'previous-reminder', kind: 'reminder',
      name: 'Предыдущее напоминание', status: 'ok' };
    const prefix = await prepareTail(file, tail, previous);
    const scheduler = f.scheduler();
    f.setTime(Date.parse(scheduledAt));
    await scheduler.tickNow();
    assert.equal(f.delivered().length, 1);
    const [spent] = await f.records();
    assert.equal(spent.disabledReason, 'spent_once');
    assert.equal(spent.lastStatus, 'ok');
    const raw = await assertHistory(f, file, tail, prefix, action.id, previous.actionId,
      /Проверить почту &lt;входящие&gt;/);
    await scheduler.tickNow();
    assert.equal(f.delivered().length, 1, 'journal recovery never replays a consumed reminder');
    assert.equal(f.modelCalls.length, 1, 'only registration invokes the synthetic model');
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  });

  test(`a completed interval survives journal tail: ${tail}`, async t => {
    const f = await fixture(t, async () => assert.fail('History must not invoke the model'),
      { overlay: false, runtimeProfile: 'jar1' });
    for (const key of ['MSB_SESSION_DIR', 'IIA_SESSION_DIR', 'AUTONOMY_DIR']) delete process.env[key];
    const file = path.join(autonomyDir(), 'runs.jsonl');
    const previous = { at: previousAt, taskId: 'previous-interval', ok: true, preview: 'previous' };
    const prefix = await prepareTail(file, tail, previous);
    const task = await addTask({ id: 'journal-interval', title: 'Проверка журнала',
      prompt: 'Проверить журнал', everyHours: 1, nextAt: 1000 });
    let calls = 0;
    const errors = [];
    const scheduler = startScheduler({ api: f.bot.api, adminId: 42,
      now: () => Date.parse(scheduledAt), log: line => { if (line.includes('error')) errors.push(line); },
      runTurn: async () => { calls++; return { ok: true, text: 'Журнал проверен' }; },
    });
    t.after(() => scheduler.stop());
    await scheduler.tickNow();
    assert.deepEqual(errors, []);
    assert.equal(calls, 1);
    assert.equal((await listTasks())[0].nextAt, Date.parse(scheduledAt) + 3600_000);
    const raw = await assertHistory(f, file, tail, prefix, task.id, previous.taskId, /journal-interval/);
    assert.equal(f.messages.filter(text => text.startsWith('🥷')).length, 1);
    await scheduler.tickNow();
    assert.equal(calls, 1);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  });
}

for (const tail of ['interrupted', 'absent']) {
  test(`a reminder appends through a linked journal with ${tail} target`, async t => {
    const f = await reminderFixture(t);
    await f.request('Напомни через 30 минут проверить почту');
    await f.final();
    const [action] = await f.records();
    const file = reminderRunPath();
    const target = path.join(f.home, 'journal-target.jsonl');
    const prefix = await prepareTail(target, tail);
    if (tail !== 'absent') await fs.chmod(target, 0o640);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.symlink(target, file);
    const scheduler = f.scheduler();
    f.setTime(Date.parse(scheduledAt));
    await scheduler.tickNow();

    assert.equal(f.delivered().length, 1);
    await assertHistory(f, file, tail, prefix, action.id, undefined, /Проверить почту/);
    assert.ok((await fs.lstat(file)).isSymbolicLink());
    assert.equal((await fs.stat(target)).mode & 0o777, tail === 'absent' ? 0o600 : 0o640);
    await assert.rejects(fs.stat(file + '.lock.sqlite'), { code: 'ENOENT' });
    await assert.rejects(fs.stat(target + '.lock.sqlite'), { code: 'ENOENT' });
  });
}

test('a journal that denies reads still records a delivered reminder', async t => {
  const f = await reminderFixture(t);
  await f.request('Напомни через 30 минут проверить почту');
  await f.final();
  const [action] = await f.records();
  const file = reminderRunPath();
  const previous = { ts: previousAt, actionId: 'previous-reminder', kind: 'reminder', status: 'ok' };
  const prefix = await prepareTail(file, 'complete without newline', previous);
  const open = fs.open;
  let denied = 0;
  t.mock.method(fs, 'open', async (name, ...args) => {
    if (name === file && args[0] === 'r') {
      denied++;
      throw Object.assign(new Error('synthetic read permission failure'), { code: 'EACCES' });
    }
    return open(name, ...args);
  });
  const scheduler = f.scheduler();
  f.setTime(Date.parse(scheduledAt));
  await scheduler.tickNow();

  assert.equal(denied, 1);
  assert.equal(f.delivered().length, 1);
  await assertHistory(f, file, 'complete without newline', prefix, action.id, previous.actionId, /Проверить почту/);
});

test('a failed journal append remains an error and preserves existing bytes', async t => {
  await reminderFixture(t);
  const file = reminderRunPath();
  const prefix = await prepareTail(file, 'interrupted');
  const append = fs.appendFile;
  const failure = Object.assign(new Error('synthetic append failure'), { code: 'EIO' });
  t.mock.method(fs, 'appendFile', async (name, ...args) => {
    if (name === file) throw failure;
    return append(name, ...args);
  });

  await assert.rejects(appendSavedActionRun({ id: 'not-written', name: 'Проверка', task: { kind: 'reminder' } },
    scheduledAt, { status: 'ok' }), error => error === failure);
  assert.equal(await fs.readFile(file, 'utf8'), prefix);
});
