import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startScheduler } from '../src/autonomy/scheduler.mjs';
import { addTask, listTasks } from '../src/autonomy/store.mjs';
import { trySessionOperation } from '../src/agent/session-operation.mjs';

test('a due background task waits for compaction and runs on the next scheduler tick', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'autonomy-compact-'));
  const previousRoot = process.env.MSB_RUNTIME_ROOT;
  process.env.MSB_RUNTIME_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.MSB_RUNTIME_ROOT;
    else process.env.MSB_RUNTIME_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const due = Date.now() - 10_000;
  await addTask({ id: 'task-one', title: 'fixture', prompt: 'fixture', everyHours: 1, nextAt: due });
  let turns = 0, messages = 0;
  const scheduler = startScheduler({ api: { sendMessage: async () => { messages++; } }, adminId: 42, log() {},
    runTurn: async () => { turns++; return { ok: true, text: 'done' }; } });
  t.after(() => scheduler.stop());
  const release = trySessionOperation();
  assert.ok(release);
  await scheduler.tickNow();
  assert.equal(turns, 0);
  assert.equal((await listTasks())[0].nextAt, due);
  release();
  await scheduler.tickNow();
  assert.equal(turns, 1);
  assert.equal(messages, 1);
  assert.ok((await listTasks())[0].nextAt > Date.now());
});
