import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginTurnHistory, historyPreview } from '../src/telegram/history.mjs';

test('history: every provider uses the same bounded journal, finish is idempotent, unknown actions stay unknown', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'history-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-06T00:00:00Z');
  for (const provider of ['claude', 'codex', 'cursor', 'qwen']) {
    const history = await beginTurnHistory({ input: 'request ' + provider, env: { HOME: home }, now: () => clock });
    history.provider(provider); clock += 2000;
    const done = { status: 'ok', text: 'answer ' + provider, delivered: true, result: { providerId: provider, toolCount: 3 } };
    await Promise.all([history.finish(done), history.finish(done)]);
  }
  const root = path.join(home, '.msb/bots/default');
  const read = async name => (await fs.readFile(path.join(root, name), 'utf8')).trim().split('\n').map(JSON.parse);
  const traces = await read('traces/2026-11-06.jsonl');
  const diary = await read('chat-diary.jsonl');
  const transcripts = await read('transcripts/2026-11-06.jsonl');
  assert.equal(traces.length, 4); assert.equal(new Set(traces.map(t => t.turnId)).size, 4);
  assert.equal(diary.length, 4); assert.equal(transcripts.length, 8);
  assert.deepEqual(traces.map(t => t.providerId), ['claude', 'codex', 'cursor', 'qwen']);
  assert.equal(traces[0].toolCalls, 3);
  assert.ok(traces.slice(1).every(t => !('toolCalls' in t)));
  assert.ok(traces.every(t => t.elapsedMs === 2000 && t.status === 'ok'));
  assert.deepEqual(diary.map(t => t.turnId), traces.map(t => t.turnId));
  assert.equal((await fs.stat(path.join(root, 'chat-diary.jsonl'))).mode & 0o777, 0o600);
});

test('history: abort/error/undelivered result do not invent a successful reply', async () => {
  for (const status of ['aborted', 'error', 'delivery_error']) {
    const rows = [];
    const h = await beginTurnHistory({ input: 'task', io: { mkdir: async () => {}, appendFile: async (file, text) => rows.push({ file, ...JSON.parse(text) }) } });
    h.provider('codex');
    await h.finish({ status, text: 'never delivered', delivered: false });
    assert.equal(rows.length, 3);
    assert.equal(rows[1].status, status); assert.equal(rows[1].providerId, 'codex');
    assert.equal(rows[2].role, 'assistant'); assert.equal(rows[2].text, '');
    assert.ok(!rows.some(r => r.kind === 'agent_reply'));
  }
});

test('history: disk failure never propagates or exposes text/path in logs', async () => {
  const logs = [];
  const h = await beginTurnHistory({ input: 'private', io: { mkdir: async () => { throw Error('private-path'); } }, log: s => logs.push(s) });
  await h.finish({ status: 'ok', text: 'private-response', delivered: true });
  assert.ok(logs.length); assert.ok(logs.every(s => !/private/.test(s)));
});

test('history preview bounds and redacts recognizable secrets', () => {
  const s = historyPreview('token=supersecret password:"secret" https://host/?tg=secret&x=ok sk-' + 'x'.repeat(30) + ' 12345678:' + 'a'.repeat(35));
  assert.doesNotMatch(s, /supersecret|"secret"|tg=secret|sk-|12345678:/);
  assert.ok(historyPreview('a'.repeat(2000)).length <= 1000);
});


test('real Telegram lifecycle records failures and original provider once, while logging failure preserves delivery', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/history-lifecycle.mjs', import.meta.url))], { encoding: 'utf8', timeout: 8000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.split('\n').find(s => s.startsWith('HISTORY_RESULT=')).slice(15));
  assert.deepEqual(result.records.map(r => r.status), ['ok', 'error', 'delivery_error']);
  assert.deepEqual(result.records.map(r => r.providerId), ['codex', 'claude', 'codex']);
  assert.equal(new Set(result.records.map(r => r.turnId)).size, 3);
  assert.equal(result.diary.length, 3);
  assert.match(result.diary[2].summary, /Ошибка: fixture delivery rejected/);
  assert.ok(!result.diary.filter(r => r.turnId === result.records[2].turnId).some(r => r.summary === 'model answer'));
  assert.ok(result.calls.some(c => c.phase === 'log-failure' && c.text?.startsWith('model answer')));
});
