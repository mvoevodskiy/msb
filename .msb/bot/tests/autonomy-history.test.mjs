import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reminderRunPath } from '../src/autonomy/reminder-runs.mjs';
import { historyLimit, historyPages, readRecentRuns } from '../src/autonomy/history.mjs';

async function profile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autonomy-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, env: { HOME: dir, AUTONOMY_DIR: dir } };
}

test('history limit follows the previous command contract', () => {
  for (const [input, expected] of [['', 10], ['abc', 10], ['0', 10], ['-4', 1], ['1', 1], ['9', 9], ['999', 50]]) {
    assert.equal(historyLimit(input), expected);
  }
});

test('history distinguishes absent, malformed, and readable rows', async (t) => {
  const { dir, env } = await profile(t);
  assert.deepEqual(await readRecentRuns({ env }), { runs: [], malformed: 0 });
  assert.deepEqual(await historyPages({ env }), ['📊 Автономка ещё не запускалась.']);
  assert.match((await historyPages({ env, menu: true }))[0], /Прогонов в журнале пока нет/);
  const entries = [
    { at: '2026-11-06T09:00:00Z', taskId: 'old', ok: true, error: null, preview: 'done' },
    { at: 'invalid', taskId: 'bad-date', ok: true },
    '{broken json',
    { at: '2026-11-06T09:05:00Z', taskId: 'new', ok: false, error: 'failure <tool>', preview: 'result & detail' },
    { at: '2026-11-06T09:06:00Z', taskId: 'invalid-status', ok: 'true' },
  ];
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${entries.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')}\n`);
  const result = await readRecentRuns({ limit: 1, env });
  assert.deepEqual(result.runs.map((item) => item.taskId), ['new']);
  assert.equal(result.malformed, 3);
  const text = (await historyPages({ limit: 2, env })).join('');
  assert.ok(text.indexOf('new') < text.indexOf('old'));
  assert.match(text, /failure &lt;tool&gt;/);
  assert.match(text, /result &amp; detail/);
  assert.match(text, /повреждённых или неподдерживаемых записей: 3/);
  assert.doesNotMatch(text, /стоимость|модель|баланс/);
  await fs.writeFile(path.join(dir, 'runs.jsonl'), 'not-json\n[]\n');
  assert.match((await historyPages({ env }))[0], /нет читаемых записей/);
});

test('long history is split without losing text, breaking entities or emoji', async (t) => {
  const { dir, env } = await profile(t);
  const preview = '<строка & 🧠> '.repeat(500);
  const row = { at: '2026-11-06T12:00:00Z', taskId: 'long', ok: true, preview };
  await fs.writeFile(path.join(dir, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
  const pages = await historyPages({ env, menu: true });
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 3500));
  assert.ok(pages.every((page) => !/&(?:a|am|amp|l|lt|g|gt)$/.test(page)));
  assert.ok(pages.every((page) => !/[\uD800-\uDBFF]$/.test(page)));
  assert.equal(pages.join('').split('&lt;строка &amp; 🧠&gt; ').length - 1, 500);
});

test('history reports unreadable storage without exposing error details', async (t) => {
  const { dir, env } = await profile(t);
  await fs.mkdir(path.join(dir, 'runs.jsonl'));
  assert.deepEqual(await historyPages({ env }), ['✖ Не удалось прочитать журнал фоновых прогонов.']);
});

test('history merges the reminder and interval schemas without duplicating a linked journal', async t => {
  const { dir, env } = await profile(t);
  const intervals = path.join(dir, 'runs.jsonl');
  const reminders = reminderRunPath(env);
  const interval = { at: '2026-11-06T09:00:00Z', taskId: 'interval', ok: true };
  const reminder = { ts: '2026-11-06T09:05:00Z', actionId: 'reminder', kind: 'reminder', status: 'ok' };
  await fs.mkdir(path.dirname(reminders), { recursive: true });
  const asLine = row => JSON.stringify(row) + '\n';
  await fs.writeFile(intervals, asLine(interval));
  await fs.writeFile(reminders, asLine(reminder));
  const expected = ['reminder', 'interval'];
  assert.deepEqual((await readRecentRuns({ env })).runs.map(run => run.taskId), expected);
  assert.deepEqual((await readRecentRuns({ env, limit: 1 })).runs.map(run => run.taskId), ['reminder']);
  await fs.appendFile(reminders, asLine(interval) + asLine({ ...reminder, status: 'stopped' }));
  await fs.unlink(intervals);
  await fs.symlink(reminders, intervals);
  const combined = await readRecentRuns({ env });
  assert.equal(combined.malformed, 0);
  assert.deepEqual(combined.runs.map(run => run.taskId), ['interval', 'reminder']);
});
